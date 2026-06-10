/**
 * Unit tests for `GET /api/account/subscription`.
 *
 * Linear: ADA-273.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handleSubscription } from '../subscription';

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request('https://hoursmith.io/api/account/subscription', {
		method: 'GET',
		headers,
	});
}

const SUBSCRIPTION = {
	user_id: 'user-123',
	stripe_customer_id: 'cus_abc',
	stripe_subscription_id: 'sub_abc',
	tier: 'premium',
	status: 'active',
	current_period_end: '2026-12-01T00:00:00Z',
};

function makeAdmin(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		getUserIdFromToken: vi.fn().mockResolvedValue('user-123'),
		getSubscription: vi.fn().mockResolvedValue(SUBSCRIPTION),
		getProfile: vi.fn(),
		getSubscriptionByCustomerId: vi.fn(),
		insertIncompleteSubscription: vi.fn(),
		upsertSubscription: vi.fn(),
		deleteSubscription: vi.fn(),
		deleteProfile: vi.fn(),
		deleteAuthUser: vi.fn(),
		signOutUser: vi.fn().mockResolvedValue(undefined),
		insertAuditLog: vi.fn(),
		recordBillingEvent: vi.fn().mockResolvedValue(true),
		...overrides,
	};
}

describe('GET /api/account/subscription', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const admin = makeAdmin();
		const res = await handleSubscription(makeRequest(), { admin });
		expect(res.status).toBe(401);
		expect(admin.getSubscription).not.toHaveBeenCalled();
	});

	it('returns { subscription: null } with 200 when the row does not exist', async () => {
		const admin = makeAdmin({
			getSubscription: vi.fn().mockResolvedValue(null),
		});
		const res = await handleSubscription(
			makeRequest({ authorization: 'Bearer ok' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-123') },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ subscription: null });
	});

	it('returns the subscription with tier+status+current_period_end on success', async () => {
		const admin = makeAdmin();
		const res = await handleSubscription(
			makeRequest({ authorization: 'Bearer ok' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-123') },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			subscription: {
				tier: 'premium',
				status: 'active',
				current_period_end: '2026-12-01T00:00:00Z',
			},
		});
	});

	it('returns 401 when the JWT verifier rejects', async () => {
		const admin = makeAdmin();
		const res = await handleSubscription(
			makeRequest({ authorization: 'Bearer bad' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue(null) },
		);
		expect(res.status).toBe(401);
		expect(admin.getSubscription).not.toHaveBeenCalled();
	});

	it('rejects non-GET methods', async () => {
		const res = await handleSubscription(
			new Request('https://hoursmith.io/api/account/subscription', {
				method: 'POST',
			}),
			{ admin: makeAdmin(), verifyJwt: vi.fn() },
		);
		expect(res.status).toBe(405);
	});
});
