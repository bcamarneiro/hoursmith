import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from '@playwright/test';

/**
 * Full paywall lifecycle against the STAGING deployment + Polar SANDBOX (ADA-274).
 *
 *   signup(admin-confirmed) → sign in → proxy 403 (not entitled) → checkout →
 *   webhook syncs → /account Active + proxy passes entitlement → cancel(API) →
 *   webhook syncs → proxy 403 again.
 *
 * This is the integration test the per-PR offline suite can't be: it exercises
 * real Supabase auth, real Polar sandbox checkout, real webhook → Supabase sync,
 * and the real hosted-proxy entitlement gate. It runs against a DEPLOYED url,
 * driven by `.github/workflows/e2e-sandbox.yml`.
 *
 * Runs ONLY when the sandbox secrets are present (otherwise every test skips,
 * so it's safe on PRs / local). Provide via the workflow env:
 *   E2E_TARGET_URL                     e.g. https://staging.hoursmith.io
 *   SUPABASE_STAGING_SERVICE_ROLE_KEY  staging branch service-role key
 *   POLAR_SANDBOX_ACCESS_TOKEN         polar_oat_… for the sandbox org
 *   POLAR_SANDBOX_PRODUCT_HOSTED       sandbox Hosted product id
 *
 * NOTE (honesty): this spec was authored from the ticket's provisioned IDs, the
 * app's real selectors, and the proxy/entitlement contract, but has NOT yet been
 * executed against staging (that needs the secrets above, which only the owner
 * can add). Two external touchpoints are marked FIRST-RUN and may need selector /
 * endpoint tweaks on the very first real run: the Polar sandbox checkout card
 * form, and the Polar cancel endpoint.
 */

// Staging Supabase branch (project ref from the ticket). The auth + PostgREST
// REST API lives under this origin; the anon-key storage key the browser
// persists is `sb-<ref>-auth-token`.
const SUPABASE_REF = 'navbjcdtwywwgrgqkyob';
const SUPABASE_URL = `https://${SUPABASE_REF}.supabase.co`;
const SUPABASE_STORAGE_KEY = `sb-${SUPABASE_REF}-auth-token`;

// Polar sandbox API base (sandbox is a separate host from production).
const POLAR_API = 'https://sandbox-api.polar.sh';

const TARGET = process.env.E2E_TARGET_URL ?? '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_STAGING_SERVICE_ROLE_KEY ?? '';
const POLAR_TOKEN = process.env.POLAR_SANDBOX_ACCESS_TOKEN ?? '';
const POLAR_PRODUCT_HOSTED = process.env.POLAR_SANDBOX_PRODUCT_HOSTED ?? '';

const MISSING = [
	['E2E_TARGET_URL', TARGET],
	['SUPABASE_STAGING_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY],
	['POLAR_SANDBOX_ACCESS_TOKEN', POLAR_TOKEN],
	['POLAR_SANDBOX_PRODUCT_HOSTED', POLAR_PRODUCT_HOSTED],
]
	.filter(([, v]) => !v)
	.map(([k]) => k);

// A proxy path that requires entitlement but no real Jira upstream to prove the
// gate: the entitlement check (403 when not subscribed) runs BEFORE the Jira
// header/upstream check, so an entitled caller gets past `subscription_required`
// (then 400 `missing_jira_headers`) and a non-entitled one gets 403. That status
// difference IS the entitlement contract.
const PROXY_PROBE_PATH = '/api/proxy/rest/api/2/myself';

type ProxyResult = { status: number; code: string | null };

/** Call the hosted proxy with a bearer token and no Jira headers. */
async function probeProxy(
	request: APIRequestContext,
	accessToken: string,
): Promise<ProxyResult> {
	const res = await request.get(`${TARGET}${PROXY_PROBE_PATH}`, {
		headers: { authorization: `Bearer ${accessToken}` },
		failOnStatusCode: false,
	});
	let code: string | null = null;
	try {
		code = ((await res.json()) as { error?: string }).error ?? null;
	} catch {
		code = null;
	}
	return { status: res.status(), code };
}

const supabaseAdminHeaders = {
	apikey: SERVICE_ROLE_KEY,
	authorization: `Bearer ${SERVICE_ROLE_KEY}`,
	'content-type': 'application/json',
};

/** Create an email-confirmed user via the Supabase admin API (the "admin stub"
 *  path the ticket allows — deterministic, no email round-trip). */
async function adminCreateUser(
	request: APIRequestContext,
	email: string,
	password: string,
): Promise<string> {
	const res = await request.post(`${SUPABASE_URL}/auth/v1/admin/users`, {
		headers: supabaseAdminHeaders,
		data: { email, password, email_confirm: true },
		failOnStatusCode: false,
	});
	expect(res.ok(), `admin createUser failed: ${await res.text()}`).toBeTruthy();
	return ((await res.json()) as { id: string }).id;
}

async function adminDeleteUser(
	request: APIRequestContext,
	userId: string,
): Promise<void> {
	await request.delete(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
		headers: supabaseAdminHeaders,
		failOnStatusCode: false,
	});
}

type SubRow = { tier: string; status: string } | null;

/** Read the user's `subscriptions` row straight from Postgres (service-role),
 *  so we observe the webhook's effect without trusting the UI. */
async function readSubscription(
	request: APIRequestContext,
	userId: string,
): Promise<SubRow> {
	const res = await request.get(
		`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=tier,status`,
		{ headers: supabaseAdminHeaders, failOnStatusCode: false },
	);
	const rows = (await res.json()) as SubRow[];
	return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** Poll until `predicate(row)` or timeout — the webhook lands a few seconds
 *  after checkout/cancel, so give it a generous window. */
async function waitForSubscription(
	request: APIRequestContext,
	userId: string,
	predicate: (row: SubRow) => boolean,
	timeoutMs = 90_000,
): Promise<SubRow> {
	const deadline = Date.now() + timeoutMs;
	let last: SubRow = null;
	while (Date.now() < deadline) {
		last = await readSubscription(request, userId);
		if (predicate(last)) return last;
		await new Promise((r) => setTimeout(r, 3000));
	}
	throw new Error(
		`subscription never satisfied predicate; last=${JSON.stringify(last)}`,
	);
}

/** Sign in through the real UI and return the persisted Supabase access token. */
async function signInAndGetToken(
	page: Page,
	email: string,
	password: string,
): Promise<string> {
	await page.goto(`${TARGET}/auth/sign-in`);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL('**/account', { timeout: 15_000 });

	const token = await page.evaluate((key) => {
		const raw = window.localStorage.getItem(key);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw);
			return parsed.access_token ?? parsed.currentSession?.access_token ?? null;
		} catch {
			return null;
		}
	}, SUPABASE_STORAGE_KEY);
	expect(token, 'no Supabase access token after sign-in').toBeTruthy();
	return token as string;
}

/** Cancel (revoke) the user's Polar sandbox subscription so the webhook emits
 *  `subscription.revoked` → our webhook maps it to tier:'free'. */
async function cancelPolarSubscriptionForCustomer(
	request: APIRequestContext,
	email: string,
): Promise<void> {
	const polarHeaders = {
		authorization: `Bearer ${POLAR_TOKEN}`,
		'content-type': 'application/json',
	};
	// Find the customer's active subscription. FIRST-RUN: confirm the sandbox
	// list/filter params against the current Polar API on the first real run.
	const list = await request.get(
		`${POLAR_API}/v1/subscriptions/?query=${encodeURIComponent(email)}&active=true`,
		{ headers: polarHeaders, failOnStatusCode: false },
	);
	const items = ((await list.json()) as { items?: { id: string }[] }).items;
	expect(
		items && items.length > 0,
		'no active Polar subscription found',
	).toBeTruthy();
	const subscriptionId = (items as { id: string }[])[0].id;

	// Revoke immediately (not cancel-at-period-end) so the entitlement cutoff is
	// observable within the test window.
	const res = await request.delete(
		`${POLAR_API}/v1/subscriptions/${subscriptionId}`,
		{
			headers: polarHeaders,
			failOnStatusCode: false,
		},
	);
	expect(res.ok(), `Polar cancel failed: ${await res.text()}`).toBeTruthy();
}

test.describe('Paywall sandbox lifecycle (ADA-274)', () => {
	test.skip(
		MISSING.length > 0,
		`sandbox secrets not configured (${MISSING.join(', ')}) — see .github/workflows/e2e-sandbox.yml`,
	);
	test.describe.configure({ mode: 'serial' });

	test('signup → subscribe → proxy access → cancel → proxy 403', async ({
		page,
		request,
	}) => {
		// Deterministic-but-unique identity per run. A fixed epoch keeps the value
		// stable for a given run without Date.now() (banned in some sandboxes);
		// the worker index + a run marker from CI keeps parallel/re-runs distinct.
		const marker = process.env.GITHUB_RUN_ID ?? `local-${process.pid}`;
		const email = `e2e+${marker}@hoursmith-e2e.dev`;
		const password = 'Str0ng-e2e-passw0rd!';

		let userId = '';
		try {
			await test.step('create an email-confirmed user (admin API)', async () => {
				userId = await adminCreateUser(request, email, password);
			});

			const accessToken = await test.step('sign in → /account', () =>
				signInAndGetToken(page, email, password));

			await test.step('proxy is 403 subscription_required before subscribing', async () => {
				const before = await probeProxy(request, accessToken);
				expect(before.status).toBe(403);
				expect(before.code).toBe('subscription_required');
			});

			await test.step('start checkout for the Hosted tier', async () => {
				await page.goto(`${TARGET}/account`);
				await page.getByRole('button', { name: /Upgrade to Hosted/ }).click();
				// The app POSTs /api/checkout and redirects to the Polar sandbox
				// checkout. Wait for the external checkout origin.
				await page.waitForURL(/polar\.sh|sandbox/, { timeout: 20_000 });
			});

			await test.step('complete Polar sandbox checkout (test card)', async () => {
				// FIRST-RUN: the Polar sandbox checkout form is an external hosted
				// page; these selectors + the test card must be confirmed on the
				// first real run and adjusted if Polar's checkout markup differs.
				await page.getByLabel(/card number/i).fill('4242424242424242');
				await page.getByLabel(/expir/i).fill('12 / 34');
				await page.getByLabel(/cvc|cvv/i).fill('123');
				await page
					.getByRole('button', { name: /subscribe|pay|complete/i })
					.click();
				// Polar redirects back to /account?upgrade=success on success.
				await page.waitForURL('**/account**', { timeout: 30_000 });
			});

			await test.step('webhook syncs → subscriptions row is premium/active', async () => {
				const row = await waitForSubscription(
					request,
					userId,
					(r) => r?.tier === 'premium' && r?.status === 'active',
				);
				expect(row).toMatchObject({ tier: 'premium', status: 'active' });
			});

			await test.step('/account shows Active and proxy passes the entitlement gate', async () => {
				await page.goto(`${TARGET}/account`);
				await expect(page.getByText('Active')).toBeVisible();
				// Entitled: the proxy gets PAST `subscription_required`. With no Jira
				// headers it now fails on those (400) instead — the point is the
				// entitlement gate no longer rejects.
				const entitled = await probeProxy(request, accessToken);
				expect(entitled.code).not.toBe('subscription_required');
				expect(entitled.status).not.toBe(403);
			});

			await test.step('cancel via Polar API → webhook syncs to free/canceled', async () => {
				await cancelPolarSubscriptionForCustomer(request, email);
				await waitForSubscription(
					request,
					userId,
					(r) => r?.tier === 'free' || r?.status === 'canceled',
				);
			});

			await test.step('proxy is 403 subscription_required again (the cutoff)', async () => {
				const after = await probeProxy(request, accessToken);
				expect(after.status).toBe(403);
				expect(after.code).toBe('subscription_required');
			});
		} finally {
			if (userId) await adminDeleteUser(request, userId);
		}
	});
});
