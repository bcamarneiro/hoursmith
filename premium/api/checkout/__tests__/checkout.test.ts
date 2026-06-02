import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutDeps, CheckoutGate } from '../index.js';
import { handleCheckout } from '../index.js';

/**
 * Behaviour contract for POST /api/checkout (Polar). Build a request, inject
 * fakes, assert on the Response. The operational gate (ADA-341) is injected
 * open by default so the pre-existing cases hit the happy path; gate-specific
 * cases override it to force closed/disabled.
 */

interface FakeSupabase {
	getUserIdFromToken: ReturnType<typeof vi.fn>;
}

function makeSupabase(userId: string | null): FakeSupabase {
	return {
		getUserIdFromToken: vi.fn(async () => userId),
	};
}

/** Permissive operational gate (ADA-341) so existing cases hit the happy path. */
function openGate(): CheckoutGate {
	return {
		checkoutEnabled: vi.fn(async () => true),
		paywallPublic: vi.fn(async () => true),
		canCheckout: vi.fn(async () => true),
	};
}

function makeRequest(body: unknown, token = 'valid-token'): Request {
	return new Request('https://hoursmith.io/api/checkout', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
}

function makeDeps(overrides: Partial<CheckoutDeps> = {}): CheckoutDeps {
	const fakeSupabase = makeSupabase('user-1');
	return {
		supabase: fakeSupabase as never,
		createCheckout: vi.fn(async () => ({
			url: 'https://polar.sh/checkout/test-session',
			id: 'cs_test_123',
		})),
		env: {
			POLAR_PRODUCT_HOSTED: 'prod_hosted',
			POLAR_PRODUCT_LEAD: 'prod_lead',
			APP_URL: 'https://hoursmith.io',
		},
		gate: openGate(),
		...overrides,
	};
}

describe('handleCheckout (Polar)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns 405 for non-POST methods', async () => {
		const res = await handleCheckout(
			new Request('https://hoursmith.io/api/checkout', { method: 'GET' }),
			makeDeps(),
		);
		expect(res.status).toBe(405);
	});

	it('returns 401 when Authorization header is missing', async () => {
		const res = await handleCheckout(
			new Request('https://hoursmith.io/api/checkout', { method: 'POST' }),
			makeDeps(),
		);
		expect(res.status).toBe(401);
	});

	it('returns 401 when Supabase rejects the JWT', async () => {
		const res = await handleCheckout(
			makeRequest({ tier: 'hosted' }, 'bad-token'),
			makeDeps({ supabase: makeSupabase(null) as never }),
		);
		expect(res.status).toBe(401);
	});

	it('returns 400 invalid_tier for missing or unknown tiers', async () => {
		const res = await handleCheckout(makeRequest({ tier: 'gold' }), makeDeps());
		expect(res.status).toBe(400);
	});

	it('returns 500 when the tier product env is missing', async () => {
		const res = await handleCheckout(
			makeRequest({ tier: 'hosted' }),
			makeDeps({ env: { APP_URL: 'https://hoursmith.io' } }),
		);
		expect(res.status).toBe(500);
	});

	it('returns 500 when APP_URL is missing', async () => {
		const res = await handleCheckout(
			makeRequest({ tier: 'hosted' }),
			makeDeps({
				env: {
					POLAR_PRODUCT_HOSTED: 'prod_hosted',
					POLAR_PRODUCT_LEAD: 'prod_lead',
				},
			}),
		);
		expect(res.status).toBe(500);
	});

	it('creates a Polar checkout for the hosted tier and returns the url', async () => {
		const deps = makeDeps();
		const res = await handleCheckout(makeRequest({ tier: 'hosted' }), deps);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { url?: string };
		expect(body.url).toBe('https://polar.sh/checkout/test-session');
		expect(deps.createCheckout).toHaveBeenCalledWith({
			productId: 'prod_hosted',
			customerExternalId: 'user-1',
			successUrl: 'https://hoursmith.io/account?upgrade=success',
		});
	});

	it('uses the lead product id for the lead tier', async () => {
		const deps = makeDeps();
		const res = await handleCheckout(makeRequest({ tier: 'lead' }), deps);
		expect(res.status).toBe(200);
		expect(deps.createCheckout).toHaveBeenCalledWith(
			expect.objectContaining({ productId: 'prod_lead' }),
		);
	});

	it('returns 502 when the Polar checkout call throws', async () => {
		const res = await handleCheckout(
			makeRequest({ tier: 'hosted' }),
			makeDeps({
				createCheckout: vi.fn(async () => {
					throw new Error('polar down');
				}),
			}),
		);
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'polar_session_failed' });
	});

	it('returns 503 when checkout is disabled (ADA-341)', async () => {
		const res = await handleCheckout(
			makeRequest({ tier: 'hosted' }),
			makeDeps({
				gate: {
					checkoutEnabled: vi.fn(async () => false),
					paywallPublic: vi.fn(async () => true),
					canCheckout: vi.fn(async () => true),
				},
			}),
		);
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error?: string }).error).toBe(
			'checkout_disabled',
		);
	});

	it('returns 403 when the paywall is closed for the caller (ADA-341)', async () => {
		const res = await handleCheckout(
			makeRequest({ tier: 'hosted' }),
			makeDeps({
				gate: {
					checkoutEnabled: vi.fn(async () => true),
					paywallPublic: vi.fn(async () => false),
					canCheckout: vi.fn(async () => false),
				},
			}),
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error?: string }).error).toBe(
			'paywall_closed',
		);
	});

	it('allows checkout when paywall closed but caller is allowlisted (ADA-341)', async () => {
		const deps = makeDeps({
			gate: {
				checkoutEnabled: vi.fn(async () => true),
				paywallPublic: vi.fn(async () => false),
				canCheckout: vi.fn(async () => true),
			},
		});
		const res = await handleCheckout(makeRequest({ tier: 'hosted' }), deps);
		expect(res.status).toBe(200);
	});
});
