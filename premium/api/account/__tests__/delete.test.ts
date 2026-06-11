/**
 * Unit tests for `POST /api/account/delete` (GDPR Article 17).
 *
 * Mocks the Polar canceller + Supabase admin via the injected-deps surface.
 *
 * Linear: ADA-294 (migrated from Stripe ADA-263).
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handleDelete } from '../delete';

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request('https://hoursmith.io/api/account/delete', {
		method: 'POST',
		headers,
	});
}

function makeAdmin(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		getProfile: vi.fn().mockResolvedValue({
			id: 'user-123',
			email: 'a@b.test',
			created_at: '2026-01-01T00:00:00Z',
		}),
		getSubscription: vi.fn().mockResolvedValue({
			user_id: 'user-123',
			stripe_customer_id: 'cus_abc',
			stripe_subscription_id: 'sub_abc',
			tier: 'premium',
			status: 'active',
			current_period_end: '2026-12-01T00:00:00Z',
			updated_at: '2026-05-01T00:00:00Z',
		}),
		deleteSubscription: vi.fn().mockResolvedValue(undefined),
		deleteProfile: vi.fn().mockResolvedValue(undefined),
		deleteAuthUser: vi.fn().mockResolvedValue(undefined),
		signOutUser: vi.fn().mockResolvedValue(undefined),
		insertAuditLog: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as SupabaseAdminClient;
}

const okCancel = () => vi.fn().mockResolvedValue(undefined);

describe('POST /api/account/delete', () => {
	it('returns 401 when the Authorization header is missing', async () => {
		const admin = makeAdmin();
		const res = await handleDelete(makeRequest(), {
			admin,
			cancelSubscription: okCancel(),
			verifyJwt: vi.fn(),
		});
		expect(res.status).toBe(401);
		expect(admin.deleteAuthUser).not.toHaveBeenCalled();
	});

	it('returns 401 when the JWT is invalid', async () => {
		const admin = makeAdmin();
		const res = await handleDelete(makeRequest({ authorization: 'Bearer x' }), {
			admin,
			cancelSubscription: okCancel(),
			verifyJwt: vi.fn().mockResolvedValue(null),
		});
		expect(res.status).toBe(401);
		expect(admin.deleteAuthUser).not.toHaveBeenCalled();
	});

	it('deletes the user and logs audit when there is no subscription row', async () => {
		const admin = makeAdmin({
			getSubscription: vi.fn().mockResolvedValue(null),
		});
		const cancelSubscription = okCancel();
		const res = await handleDelete(
			makeRequest({ authorization: 'Bearer ok' }),
			{
				admin,
				cancelSubscription,
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
			},
		);
		expect(res.status).toBe(204);
		expect(cancelSubscription).not.toHaveBeenCalled();
		expect(admin.deleteSubscription).toHaveBeenCalledWith('user-123');
		expect(admin.deleteProfile).toHaveBeenCalledWith('user-123');
		expect(admin.deleteAuthUser).toHaveBeenCalledWith('user-123');
		// ADA-313: the verified JWT is globally signed out after the delete.
		expect(admin.signOutUser).toHaveBeenCalledWith('ok');
		expect(admin.insertAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: 'account_deleted',
				stripe_customer_id: null,
			}),
		);
	});

	it('cancels the Polar subscription + deletes + logs when active', async () => {
		const admin = makeAdmin();
		const cancelSubscription = okCancel();
		const res = await handleDelete(
			makeRequest({ authorization: 'Bearer ok' }),
			{
				admin,
				cancelSubscription,
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
			},
		);
		expect(res.status).toBe(204);
		expect(cancelSubscription).toHaveBeenCalledWith('sub_abc');
		expect(admin.deleteAuthUser).toHaveBeenCalledWith('user-123');
		expect(admin.insertAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: 'account_deleted',
				stripe_customer_id: 'cus_abc',
				metadata: expect.objectContaining({ polar_cancel: 'ok' }),
			}),
		);
	});

	it('still deletes the user when Polar cancel throws; audit captures the error', async () => {
		const admin = makeAdmin();
		const cancelSubscription = vi
			.fn()
			.mockRejectedValue(new Error('polar down'));
		const res = await handleDelete(
			makeRequest({ authorization: 'Bearer ok' }),
			{
				admin,
				cancelSubscription,
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
			},
		);
		expect(res.status).toBe(204);
		expect(admin.deleteAuthUser).toHaveBeenCalledWith('user-123');
		expect(admin.insertAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: 'account_deleted',
				stripe_customer_id: 'cus_abc',
				metadata: expect.objectContaining({
					polar_cancel: 'error',
					polar_error: 'polar down',
				}),
			}),
		);
	});

	it('returns 500 and writes NO audit log when Supabase delete fails (retry-clean)', async () => {
		const admin = makeAdmin({
			deleteAuthUser: vi.fn().mockRejectedValue(new Error('rls error')),
		});
		const res = await handleDelete(
			makeRequest({ authorization: 'Bearer ok' }),
			{
				admin,
				cancelSubscription: okCancel(),
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
			},
		);
		expect(res.status).toBe(500);
		expect(admin.insertAuditLog).not.toHaveBeenCalled();
		// ADA-313: nothing was deleted, so we must not attempt a global signout.
		expect(admin.signOutUser).not.toHaveBeenCalled();
	});

	it('globally signs out the verified JWT after a successful delete (ADA-313)', async () => {
		const admin = makeAdmin();
		const res = await handleDelete(
			makeRequest({ authorization: 'Bearer the-jwt' }),
			{
				admin,
				cancelSubscription: okCancel(),
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
			},
		);
		expect(res.status).toBe(204);
		expect(admin.deleteAuthUser).toHaveBeenCalledWith('user-123');
		expect(admin.signOutUser).toHaveBeenCalledWith('the-jwt');
	});

	it('still succeeds and logs audit when the global signout fails (best-effort, ADA-313)', async () => {
		const admin = makeAdmin({
			signOutUser: vi.fn().mockRejectedValue(new Error('gotrue down')),
		});
		const res = await handleDelete(
			makeRequest({ authorization: 'Bearer the-jwt' }),
			{
				admin,
				cancelSubscription: okCancel(),
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
			},
		);
		// Account is already deleted; a revocation failure must not 500 or skip
		// the audit log.
		expect(res.status).toBe(204);
		expect(admin.signOutUser).toHaveBeenCalledWith('the-jwt');
		expect(admin.insertAuditLog).toHaveBeenCalled();
	});

	it('rejects non-POST methods', async () => {
		const res = await handleDelete(
			new Request('https://hoursmith.io/api/account/delete', { method: 'GET' }),
			{
				admin: makeAdmin(),
				cancelSubscription: okCancel(),
				verifyJwt: vi.fn(),
			},
		);
		expect(res.status).toBe(405);
	});
});
