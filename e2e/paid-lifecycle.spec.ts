import { expect, type Page, test } from '@playwright/test';

// Offline mode serves mock data through an MSW service worker, which
// `page.route` cannot intercept. This spec mocks every endpoint it needs
// (Supabase auth via localStorage, the `subscriptions` read, `/api/flags`,
// `/api/checkout`) and needs no MSW-backed Jira data, so block the worker to
// let Playwright's route interception win.
test.use({ serviceWorkers: 'block' });

/**
 * Paid subscription lifecycle (ADA-274).
 *
 * Walks a signed-in premium user through the states the billing webhook drives
 * on their `subscriptions` row — active → canceled → revoked(free) — and
 * asserts the /account surface reflects each, including the loss of entitlement
 * at the end (the "subscription lapsed / must resubscribe" cutoff).
 *
 * This needs the PREMIUM route table (`/account`, auth) and a Supabase client,
 * so it only runs against a premium build. Two-terminal flow:
 *
 *   npm run dev:premium:offline:e2e     # premium + offline + mock Supabase env
 *   npm run test:e2e:lifecycle          # this spec, against that server
 *
 * On a Free-tier build (`/account` not mounted) every test self-skips.
 *
 * The billing backend is fully mocked at the network layer:
 *   - the Supabase session is injected into localStorage (getSession reads it
 *     with no network call — AuthProvider derives `user` from session.user);
 *   - the Supabase `subscriptions` PostgREST read is intercepted per-state;
 *   - `/api/flags` is opened so the upgrade / resubscribe CTAs render.
 */

// A far-future expiry so supabase-js never fires a token refresh (which would
// hit the mock URL and fail). Unix seconds, ~year 2100.
const FAR_FUTURE = 4102444800;
const USER_ID = '00000000-0000-4000-8000-000000000274';

type SubRow = {
	tier: 'free' | 'premium';
	status: string;
	current_period_end: string | null;
};

// Supabase-js derives its storage key from the project ref (first hostname
// label of VITE_SUPABASE_URL). `https://mock.supabase.co` → `mock`.
const STORAGE_KEY = 'sb-mock-auth-token';

function mockSession() {
	return {
		access_token: 'e2e-mock-access-token',
		refresh_token: 'e2e-mock-refresh-token',
		token_type: 'bearer',
		expires_in: 3600,
		expires_at: FAR_FUTURE,
		user: {
			id: USER_ID,
			aud: 'authenticated',
			role: 'authenticated',
			email: 'subscriber@example.com',
			created_at: '2026-01-01T00:00:00Z',
			app_metadata: { provider: 'email' },
			user_metadata: {},
		},
	};
}

const OPEN_FLAGS = {
	maintenanceMode: false,
	checkoutEnabled: true,
	paywallPublic: true,
	paywallOpenForMe: true,
	announcementBanner: null,
};

/**
 * Sign the browser in as our mock user and pin the billing endpoints. `row`
 * is the `subscriptions` row the PostgREST read returns (null = no row).
 */
async function signInWithSubscription(page: Page, row: SubRow | null) {
	await page.addInitScript(
		([key, session]) => {
			window.localStorage.setItem(key as string, JSON.stringify(session));
		},
		[STORAGE_KEY, mockSession()] as const,
	);

	// Supabase `.maybeSingle()` reads an array and takes the first row.
	await page.route('**/rest/v1/subscriptions**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(row ? [row] : []),
		}),
	);

	await page.route('**/api/flags**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(OPEN_FLAGS),
		}),
	);
}

/**
 * Open /account and return whether the premium route actually mounted (a Free
 * build renders no Account heading → the caller skips).
 */
async function openAccount(page: Page): Promise<boolean> {
	await page.goto('/account');
	return page
		.getByRole('heading', { name: 'Account', level: 1 })
		.waitFor({ state: 'visible', timeout: 8000 })
		.then(() => true)
		.catch(() => false);
}

test.describe('Paid subscription lifecycle', () => {
	test('active premium subscriber sees Hosted / Active and a manage action', async ({
		page,
	}) => {
		await signInWithSubscription(page, {
			tier: 'premium',
			status: 'active',
			current_period_end: '2026-12-31T23:59:59Z',
		});
		if (!(await openAccount(page))) {
			test.skip(true, '/account not mounted — run with BUILD_TIER=premium');
			return;
		}

		const subscription = page
			.getByRole('heading', { name: 'Subscription' })
			.locator('xpath=ancestor::section');
		await expect(subscription.getByText('Hosted')).toBeVisible();
		await expect(subscription.getByText('Active')).toBeVisible();
		// Active subscriptions renew (not "Ends").
		await expect(subscription.getByText('Renews')).toBeVisible();
		// An active subscriber is not offered an upgrade/resubscribe CTA.
		await expect(
			subscription.getByRole('button', { name: /Upgrade to|Resubscribe/ }),
		).toHaveCount(0);
	});

	test('canceled subscription shows Canceled / Ends and a Resubscribe CTA', async ({
		page,
	}) => {
		await signInWithSubscription(page, {
			tier: 'premium',
			status: 'canceled',
			current_period_end: '2026-12-31T23:59:59Z',
		});
		if (!(await openAccount(page))) {
			test.skip(true, '/account not mounted — run with BUILD_TIER=premium');
			return;
		}

		const subscription = page
			.getByRole('heading', { name: 'Subscription' })
			.locator('xpath=ancestor::section');
		await expect(subscription.getByText('Canceled')).toBeVisible();
		// A canceled sub reports when access "Ends", not "Renews".
		await expect(subscription.getByText('Ends')).toBeVisible();
		await expect(
			subscription.getByRole('button', { name: 'Resubscribe' }),
		).toBeVisible();
	});

	test('revoked subscription drops to Free / No subscription with an upgrade CTA', async ({
		page,
	}) => {
		// After the dunning grace window the webhook revokes access → tier:'free'.
		// This is the real entitlement cutoff: hosted-proxy access is gone and the
		// user must upgrade again.
		await signInWithSubscription(page, null);
		if (!(await openAccount(page))) {
			test.skip(true, '/account not mounted — run with BUILD_TIER=premium');
			return;
		}

		const subscription = page
			.getByRole('heading', { name: 'Subscription' })
			.locator('xpath=ancestor::section');
		await expect(subscription.getByText('Free')).toBeVisible();
		await expect(subscription.getByText('No subscription')).toBeVisible();
		await expect(
			subscription.getByRole('button', { name: /Upgrade to Hosted/ }),
		).toBeVisible();
	});

	test('clicking upgrade starts checkout and redirects to the Polar URL', async ({
		page,
	}) => {
		// The checkout call is the entry point of the lifecycle. Mock /api/checkout
		// and assert the app follows the returned hosted checkout URL.
		await signInWithSubscription(page, null);
		await page.route('**/api/checkout**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ url: '/checkout-redirect-landing' }),
			}),
		);
		if (!(await openAccount(page))) {
			test.skip(true, '/account not mounted — run with BUILD_TIER=premium');
			return;
		}

		await page.getByRole('button', { name: /Upgrade to Hosted/ }).click();
		// The app assigns window.location to the checkout URL.
		await page.waitForURL('**/checkout-redirect-landing', { timeout: 8000 });
		expect(page.url()).toContain('/checkout-redirect-landing');
	});
});
