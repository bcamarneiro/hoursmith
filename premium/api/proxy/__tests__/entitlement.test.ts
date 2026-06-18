/**
 * Unit tests for the entitlement helper.
 *
 * Linear: ADA-272.
 *
 * We mock the Supabase-like client directly via the {@link SupabaseLikeClient}
 * interface — no Supabase install or network calls. Once ADA-254 wires the
 * real SDK, the underlying client changes but these tests stay the same.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	getEntitlement,
	type SupabaseLikeClient,
} from '../../_lib/entitlement';

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request('https://hoursmith.io/api/proxy/rest/api/2/myself', {
		method: 'GET',
		headers,
	});
}

function makeClient(
	overrides: Partial<SupabaseLikeClient> = {},
): SupabaseLikeClient {
	return {
		getUserIdFromToken: vi.fn().mockResolvedValue('user-123'),
		getSubscription: vi.fn().mockResolvedValue({
			tier: 'premium',
			status: 'active',
			current_period_end: FUTURE,
		}),
		...overrides,
	};
}

// A period end safely in the future / past relative to the 2-day grace window.
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const LONG_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

describe('getEntitlement', () => {
	it('returns 401 when the Authorization header is missing', async () => {
		const result = await getEntitlement(makeRequest(), {
			client: makeClient(),
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.code).toBe('missing_token');
	});

	it('returns 401 when the Authorization header is not a Bearer token', async () => {
		const result = await getEntitlement(
			makeRequest({ authorization: 'Basic abcdef' }),
			{ client: makeClient() },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.code).toBe('missing_token');
	});

	it('returns 401 when Supabase rejects the JWT', async () => {
		const client = makeClient({
			getUserIdFromToken: vi.fn().mockResolvedValue(null),
		});
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer not-a-real-jwt' }),
			{ client },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.code).toBe('invalid_token');
		// Subscription lookup must not have been attempted.
		expect(client.getSubscription).not.toHaveBeenCalled();
	});

	it('returns 403 when the user has no subscriptions row', async () => {
		const client = makeClient({
			getSubscription: vi.fn().mockResolvedValue(null),
		});
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer valid' }),
			{ client },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(403);
		expect(result.code).toBe('subscription_required');
	});

	it('returns 403 when the subscription is canceled', async () => {
		const client = makeClient({
			getSubscription: vi
				.fn()
				.mockResolvedValue({ tier: 'premium', status: 'canceled' }),
		});
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer valid' }),
			{ client },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(403);
		expect(result.code).toBe('subscription_required');
	});

	it('returns 403 for revoked / not-yet-active statuses (canceled / unpaid / incomplete)', async () => {
		for (const status of ['canceled', 'unpaid', 'incomplete'] as const) {
			const client = makeClient({
				getSubscription: vi.fn().mockResolvedValue({ tier: 'premium', status }),
			});
			const result = await getEntitlement(
				makeRequest({ authorization: 'Bearer valid' }),
				{ client },
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.status).toBe(403);
			expect(result.code).toBe('subscription_required');
		}
	});

	it('stays entitled during the past_due dunning grace window (ADA-371)', async () => {
		// Polar retries the failed renewal for ~2 weeks before emitting
		// `subscription.revoked`; until then proxy access must survive a
		// transient card decline. Must agree with the client useSubscription
		// check, which also treats `past_due` as active.
		const client = makeClient({
			getSubscription: vi.fn().mockResolvedValue({
				tier: 'premium',
				status: 'past_due',
				current_period_end: FUTURE,
			}),
		});
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer valid' }),
			{ client },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe('past_due');
		expect(result.tier).toBe('premium');
	});

	it('returns Entitlement for trialing subscriptions', async () => {
		const client = makeClient({
			getSubscription: vi.fn().mockResolvedValue({
				tier: 'premium',
				status: 'trialing',
				current_period_end: FUTURE,
			}),
		});
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer valid' }),
			{ client },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe('trialing');
	});

	it('returns Entitlement on valid JWT + active subscription', async () => {
		const client = makeClient();
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer good-jwt' }),
			{ client },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.userId).toBe('user-123');
		expect(result.tier).toBe('premium');
		expect(result.status).toBe('active');
		expect(client.getUserIdFromToken).toHaveBeenCalledWith('good-jwt');
		expect(client.getSubscription).toHaveBeenCalledWith('user-123');
	});

	it('returns 403 for a stale active row whose period elapsed past grace (ADA-454)', async () => {
		const client = makeClient({
			getSubscription: vi.fn().mockResolvedValue({
				tier: 'premium',
				status: 'active',
				current_period_end: LONG_AGO,
			}),
		});
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer valid' }),
			{ client },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(403);
		expect(result.code).toBe('subscription_required');
	});

	it('returns 403 for a stale past_due row whose period elapsed past grace (ADA-454)', async () => {
		const client = makeClient({
			getSubscription: vi.fn().mockResolvedValue({
				tier: 'premium',
				status: 'past_due',
				current_period_end: LONG_AGO,
			}),
		});
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer valid' }),
			{ client },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(403);
	});

	it('stays entitled within the grace window after period end (ADA-454)', async () => {
		// 1 day past period end — inside the 2-day grace window.
		const justEnded = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const client = makeClient({
			getSubscription: vi.fn().mockResolvedValue({
				tier: 'premium',
				status: 'active',
				current_period_end: justEnded,
			}),
		});
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer valid' }),
			{ client },
		);
		expect(result.ok).toBe(true);
	});

	it('honours a row with a null current_period_end (ADA-454)', async () => {
		const client = makeClient({
			getSubscription: vi.fn().mockResolvedValue({
				tier: 'premium',
				status: 'active',
				current_period_end: null,
			}),
		});
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer valid' }),
			{ client },
		);
		expect(result.ok).toBe(true);
	});

	it('trims surrounding whitespace inside the Bearer scheme', async () => {
		const client = makeClient();
		const result = await getEntitlement(
			makeRequest({ authorization: 'Bearer    token-with-leading-space' }),
			{ client },
		);
		expect(result.ok).toBe(true);
		expect(client.getUserIdFromToken).toHaveBeenCalledWith(
			'token-with-leading-space',
		);
	});

	it('returns 500 when env-driven client is not configured (no test client injected)', async () => {
		const prevUrl = process.env.SUPABASE_URL;
		const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
		delete process.env.SUPABASE_URL;
		delete process.env.SUPABASE_SERVICE_ROLE_KEY;
		try {
			const result = await getEntitlement(
				makeRequest({ authorization: 'Bearer x' }),
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.status).toBe(500);
			expect(result.code).toBe('server_misconfigured');
		} finally {
			if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
			if (prevKey !== undefined)
				process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
		}
	});
});
