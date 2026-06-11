/**
 * Unit tests for `GET /api/account/export` (GDPR Article 20).
 *
 * Linear: ADA-264.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handleExport } from '../export';

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request('https://hoursmith.io/api/account/export', {
		method: 'GET',
		headers,
	});
}

const PROFILE = {
	id: 'user-123',
	email: 'a@b.test',
	created_at: '2026-01-01T00:00:00Z',
};

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
		getProfile: vi.fn().mockResolvedValue(PROFILE),
		getSubscription: vi.fn().mockResolvedValue(SUBSCRIPTION),
		getSubscriptionByCustomerId: vi.fn().mockResolvedValue(null),
		getUserIdFromToken: vi.fn().mockResolvedValue(null),
		insertIncompleteSubscription: vi.fn().mockResolvedValue(undefined),
		upsertSubscription: vi.fn().mockResolvedValue(undefined),
		deleteSubscription: vi.fn(),
		deleteProfile: vi.fn(),
		deleteAuthUser: vi.fn(),
		signOutUser: vi.fn().mockResolvedValue(undefined),
		insertAuditLog: vi.fn().mockResolvedValue(undefined),
		recordBillingEvent: vi.fn().mockResolvedValue(true),
		...overrides,
	};
}

describe('GET /api/account/export', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const admin = makeAdmin();
		const res = await handleExport(makeRequest(), {
			admin,
			verifyJwt: vi.fn(),
		});
		expect(res.status).toBe(401);
		expect(admin.getProfile).not.toHaveBeenCalled();
	});

	it('returns 401 when JWT is invalid', async () => {
		const admin = makeAdmin();
		const res = await handleExport(makeRequest({ authorization: 'Bearer x' }), {
			admin,
			verifyJwt: vi.fn().mockResolvedValue(null),
		});
		expect(res.status).toBe(401);
		expect(admin.getProfile).not.toHaveBeenCalled();
	});

	it('returns a JSON export with subscription:null when there is no subscription', async () => {
		const admin = makeAdmin({
			getSubscription: vi.fn().mockResolvedValue(null),
		});
		const res = await handleExport(
			makeRequest({ authorization: 'Bearer ok' }),
			{
				admin,
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.profile).toEqual(PROFILE);
		expect(body.subscription).toBeNull();
		expect(body.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(body.invoices_url).toMatch(/^https:\/\//);
		expect(body.notes).toContain('Jira data is not exported');
		expect(admin.insertAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: 'data_exported',
				stripe_customer_id: null,
			}),
		);
	});

	it('returns a fully populated export when subscription exists', async () => {
		const admin = makeAdmin();
		const res = await handleExport(
			makeRequest({ authorization: 'Bearer ok' }),
			{
				admin,
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
				portalUrl: 'https://polar.sh/portal/test',
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.profile).toEqual(PROFILE);
		expect(body.subscription).toEqual({
			tier: 'premium',
			status: 'active',
			current_period_end: '2026-12-01T00:00:00Z',
			customer_id: 'cus_abc',
		});
		expect(body.invoices_url).toBe('https://polar.sh/portal/test');
		// No payment-method / token leakage.
		expect(JSON.stringify(body)).not.toMatch(/sub_abc/);
		expect(JSON.stringify(body)).not.toMatch(/password|token|secret/i);
		expect(admin.insertAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: 'data_exported',
				stripe_customer_id: 'cus_abc',
			}),
		);
	});

	it('sets attachment Content-Disposition and JSON Content-Type', async () => {
		const admin = makeAdmin();
		const res = await handleExport(
			makeRequest({ authorization: 'Bearer ok' }),
			{
				admin,
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
			},
		);
		expect(res.headers.get('content-type')).toContain('application/json');
		const disposition = res.headers.get('content-disposition');
		expect(disposition).toMatch(
			/^attachment; filename="hoursmith-export-\d{4}-\d{2}-\d{2}\.json"$/,
		);
	});

	it('rejects non-GET methods', async () => {
		const res = await handleExport(
			new Request('https://hoursmith.io/api/account/export', {
				method: 'POST',
			}),
			{ admin: makeAdmin(), verifyJwt: vi.fn() },
		);
		expect(res.status).toBe(405);
	});

	it('returns 404 when profile is missing for an authenticated user', async () => {
		const admin = makeAdmin({
			getProfile: vi.fn().mockResolvedValue(null),
		});
		const res = await handleExport(
			makeRequest({ authorization: 'Bearer ok' }),
			{
				admin,
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
			},
		);
		expect(res.status).toBe(404);
		expect(admin.insertAuditLog).not.toHaveBeenCalled();
	});
});
