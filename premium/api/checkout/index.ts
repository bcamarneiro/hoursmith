/**
 * Polar Checkout Session creator for Hoursmith Premium.
 *
 * `POST /api/checkout` with `{ tier: 'hosted' | 'lead' }` and a Supabase JWT in
 * the `Authorization: Bearer ...` header. Returns `{ url }` pointing at
 * Polar-hosted Checkout. The frontend redirects there; the Polar webhook
 * (polar/webhook.ts) flips the subscription to `active` once payment clears.
 *
 * Pricing model (fixed annual, ADA-304): the amount lives on the Polar product,
 * not in the request — the caller only picks a tier. Each tier maps to a Polar
 * product id via env:
 *   - hosted → POLAR_PRODUCT_HOSTED  (€29/yr)
 *   - lead   → POLAR_PRODUCT_LEAD    (€60/yr)
 *
 * Customer linkage: we pass `customer_external_id = <supabase user id>`, so
 * Polar creates/links the customer for us — no pre-provisioning, no stub row.
 * The webhook is what writes the `subscriptions` row.
 *
 * Logging discipline (compliance-critical):
 *   DO log:    timestamp, user_id, tier, success/error code.
 *   DO NOT log: the checkout URL, request body, Authorization header.
 *
 * Linear: ADA-294 (migrated from Stripe ADA-260).
 */

import { emailFromToken } from '../_lib/authEmail.js';
import { canCheckout, checkoutEnabled, paywallPublic } from '../_lib/flags.js';
import {
	type CreateCheckoutInput,
	createPolarCheckout,
} from '../_lib/polarClient.js';
import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';

// Pin to Frankfurt for GDPR residency. Mirrors vercel.json.
// Edge-compatible: Polar client is fetch-only, Supabase REST is fetch-only.
export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export type CheckoutTier = 'hosted' | 'lead';

/** Maps the chosen tier to the env var holding its Polar product id. */
const TIER_PRODUCT_ENV: Record<CheckoutTier, string> = {
	hosted: 'POLAR_PRODUCT_HOSTED',
	lead: 'POLAR_PRODUCT_LEAD',
};

/**
 * Operational gate (ADA-341). Extracted so tests can force open/closed states
 * without an Edge Config connection; defaults bind to the live flag helpers.
 */
export interface CheckoutGate {
	checkoutEnabled(): Promise<boolean>;
	paywallPublic(): Promise<boolean>;
	canCheckout(email: string | null): Promise<boolean>;
}

export interface CheckoutDeps {
	/** Inject Supabase admin client (tests). */
	supabase?: SupabaseAdminClient;
	/** Inject the Polar checkout creator (tests). */
	createCheckout?: (
		input: CreateCheckoutInput,
	) => Promise<{ url: string; id: string }>;
	/** Inject env reader (tests). Defaults to `process.env`. */
	env?: Partial<Record<string, string | undefined>>;
	/** Inject the operational gate (tests). Defaults to Edge Config flags. */
	gate?: CheckoutGate;
}

export default async function handler(request: Request): Promise<Response> {
	return handleCheckout(request);
}

export async function handleCheckout(
	request: Request,
	deps: CheckoutDeps = {},
): Promise<Response> {
	const start = Date.now();
	const env = deps.env ?? process.env;
	const gate: CheckoutGate = deps.gate ?? {
		checkoutEnabled: () => checkoutEnabled(env),
		paywallPublic: () => paywallPublic(env),
		canCheckout: (email) => canCheckout(email, env),
	};

	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	// 1. Auth: verify the Supabase JWT. We don't need an active subscription
	//    (the user is about to create one), only a valid logged-in identity.
	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		logCheckout({
			userId: null,
			tier: null,
			code: 'missing_token',
			status: 401,
			durationMs: Date.now() - start,
		});
		return jsonResponse(401, { error: 'missing_token' });
	}

	let supabase: SupabaseAdminClient;
	try {
		supabase = deps.supabase ?? defaultSupabaseAdmin();
	} catch {
		logCheckout({
			userId: null,
			tier: null,
			code: 'server_misconfigured',
			status: 500,
			durationMs: Date.now() - start,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	const userId = await supabase.getUserIdFromToken(token);
	if (!userId) {
		logCheckout({
			userId: null,
			tier: null,
			code: 'invalid_token',
			status: 401,
			durationMs: Date.now() - start,
		});
		return jsonResponse(401, { error: 'invalid_token' });
	}

	// 1b. Operational kill switches (ADA-341). Block when checkout is disabled,
	//     and enforce the closed-launch paywall (email allowlist) before opening
	//     a session. The /api/polar/webhook stays ungated elsewhere.
	if (!(await gate.checkoutEnabled())) {
		logCheckout({
			userId,
			tier: null,
			code: 'checkout_disabled',
			status: 503,
			durationMs: Date.now() - start,
		});
		return jsonResponse(503, { error: 'checkout_disabled' });
	}
	if (!(await gate.paywallPublic())) {
		const email = await emailFromToken(token, env);
		if (!(await gate.canCheckout(email))) {
			logCheckout({
				userId,
				tier: null,
				code: 'paywall_closed',
				status: 403,
				durationMs: Date.now() - start,
			});
			return jsonResponse(403, { error: 'paywall_closed' });
		}
	}

	// 2. Parse body and validate the tier.
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		body = null;
	}
	const tier = parseTier(body);
	if (!tier) {
		logCheckout({
			userId,
			tier: null,
			code: 'invalid_tier',
			status: 400,
			durationMs: Date.now() - start,
		});
		return jsonResponse(400, { error: 'invalid_tier' });
	}

	// 3. Resolve env-driven config: the Polar product for this tier + app URL.
	const productId = env[TIER_PRODUCT_ENV[tier]];
	const appUrl = env.APP_URL;
	if (!productId || !appUrl) {
		logCheckout({
			userId,
			tier,
			code: 'server_misconfigured',
			status: 500,
			durationMs: Date.now() - start,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	// 4. Create the Polar Checkout Session. Polar links/creates the customer
	//    from `customer_external_id`, so there's no Stripe-style pre-provisioning.
	const createCheckout = deps.createCheckout ?? createPolarCheckout;
	let url: string;
	try {
		const result = await createCheckout({
			productId,
			customerExternalId: userId,
			successUrl: `${appUrl.replace(/\/+$/, '')}/account?upgrade=success`,
		});
		url = result.url;
	} catch (err) {
		logCheckout({
			userId,
			tier,
			code: 'polar_session_failed',
			status: 502,
			durationMs: Date.now() - start,
			detail: (err as Error).message,
		});
		return jsonResponse(502, { error: 'polar_session_failed' });
	}

	logCheckout({
		userId,
		tier,
		code: 'ok',
		status: 200,
		durationMs: Date.now() - start,
	});
	return jsonResponse(200, { url });
}

function parseTier(body: unknown): CheckoutTier | null {
	if (!body || typeof body !== 'object') return null;
	const raw = (body as { tier?: unknown }).tier;
	return raw === 'hosted' || raw === 'lead' ? raw : null;
}

function extractBearer(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

interface CheckoutLogFields {
	userId: string | null;
	tier: CheckoutTier | null;
	code: string;
	status: number;
	durationMs: number;
	detail?: string;
}

/** Structured log line. Scrubbed: no headers, no body, no checkout URL. */
function logCheckout(fields: CheckoutLogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-checkout',
			user_id: fields.userId,
			tier: fields.tier,
			code: fields.code,
			status: fields.status,
			duration_ms: fields.durationMs,
			...(fields.detail ? { detail: fields.detail } : {}),
		}),
	);
}
