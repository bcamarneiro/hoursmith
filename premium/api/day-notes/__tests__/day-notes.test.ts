/**
 * Unit tests for the day-notes CRUD endpoint.
 *
 * Linear: ADA-594.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handleDayNotes } from '../index';

function makeRequest(
	method: string,
	headers: Record<string, string> = {},
	body?: unknown,
): Request {
	const init: RequestInit = { method, headers };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		(headers as Record<string, string>)['content-type'] = 'application/json';
	}
	return new Request('https://hoursmith.io/api/day-notes', init);
}

const NOTE1 = {
	id: 'n1',
	user_id: 'user-123',
	date: '2026-07-01',
	note: 'sprint planning day',
	created_at: '2026-07-01T00:00:00Z',
	updated_at: '2026-07-01T00:00:00Z',
};

const NOTE2 = {
	id: 'n2',
	user_id: 'user-123',
	date: '2026-07-04',
	note: 'us holiday',
	created_at: '2026-07-04T00:00:00Z',
	updated_at: '2026-07-04T00:00:00Z',
};

function makeAdmin(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		getUserIdFromToken: vi.fn(),
		getProfile: vi.fn(),
		getSubscription: vi.fn(),
		getSubscriptionByCustomerId: vi.fn(),
		insertIncompleteSubscription: vi.fn(),
		upsertSubscription: vi.fn(),
		deleteSubscription: vi.fn(),
		deleteProfile: vi.fn(),
		deleteAuthUser: vi.fn(),
		signOutUser: vi.fn(),
		insertAuditLog: vi.fn(),
		recordBillingEvent: vi.fn(),
		getDayNotes: vi.fn().mockResolvedValue([NOTE1, NOTE2]),
		upsertDayNote: vi.fn().mockResolvedValue(undefined),
		deleteDayNote: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe('day-notes CRUD endpoint', () => {
	describe('authentication', () => {
		it('returns 401 when Authorization header is missing', async () => {
			const res = await handleDayNotes(makeRequest('GET'), {
				admin: makeAdmin(),
			});
			expect(res.status).toBe(401);
		});

		it('returns 401 when the JWT verifier rejects', async () => {
			const res = await handleDayNotes(
				makeRequest('GET', { authorization: 'Bearer bad' }),
				{
					admin: makeAdmin(),
					verifyJwt: vi.fn().mockResolvedValue(null),
				},
			);
			expect(res.status).toBe(401);
		});

		it('rejects non-GET/PUT/DELETE methods', async () => {
			const res = await handleDayNotes(
				makeRequest('POST', { authorization: 'Bearer ok' }),
				{
					admin: makeAdmin(),
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(405);
		});
	});

	describe('GET /api/day-notes', () => {
		it('returns the authenticated user notes', async () => {
			const admin = makeAdmin();
			const res = await handleDayNotes(
				makeRequest('GET', { authorization: 'Bearer ok' }),
				{
					admin,
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({
				notes: [
					{
						id: 'n1',
						date: '2026-07-01',
						note: 'sprint planning day',
						created_at: '2026-07-01T00:00:00Z',
						updated_at: '2026-07-01T00:00:00Z',
					},
					{
						id: 'n2',
						date: '2026-07-04',
						note: 'us holiday',
						created_at: '2026-07-04T00:00:00Z',
						updated_at: '2026-07-04T00:00:00Z',
					},
				],
			});
			expect(admin.getDayNotes).toHaveBeenCalledWith('user-123');
		});

		it('returns empty array when user has no notes', async () => {
			const admin = makeAdmin({ getDayNotes: vi.fn().mockResolvedValue([]) });
			const res = await handleDayNotes(
				makeRequest('GET', { authorization: 'Bearer ok' }),
				{
					admin,
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ notes: [] });
		});
	});

	describe('PUT /api/day-notes', () => {
		it('upserts a note and returns ok', async () => {
			const admin = makeAdmin();
			const res = await handleDayNotes(
				makeRequest(
					'PUT',
					{ authorization: 'Bearer ok' },
					{ date: '2026-07-15', note: 'vacation' },
				),
				{
					admin,
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, date: '2026-07-15' });
			expect(admin.upsertDayNote).toHaveBeenCalledWith({
				userId: 'user-123',
				date: '2026-07-15',
				note: 'vacation',
			});
		});

		it('returns 400 when date is missing', async () => {
			const admin = makeAdmin();
			const res = await handleDayNotes(
				makeRequest(
					'PUT',
					{ authorization: 'Bearer ok' },
					{ note: 'no date here' },
				),
				{
					admin,
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(400);
			expect(admin.upsertDayNote).not.toHaveBeenCalled();
		});

		it('returns 400 when note is missing', async () => {
			const admin = makeAdmin();
			const res = await handleDayNotes(
				makeRequest(
					'PUT',
					{ authorization: 'Bearer ok' },
					{ date: '2026-07-15' },
				),
				{
					admin,
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(400);
			expect(admin.upsertDayNote).not.toHaveBeenCalled();
		});

		it('returns 400 when date format is invalid', async () => {
			const admin = makeAdmin();
			const res = await handleDayNotes(
				makeRequest(
					'PUT',
					{ authorization: 'Bearer ok' },
					{ date: 'not-a-date', note: 'hello' },
				),
				{
					admin,
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(400);
		});

		it('returns 400 for invalid JSON body', async () => {
			const admin = makeAdmin();
			const req = new Request('https://hoursmith.io/api/day-notes', {
				method: 'PUT',
				headers: {
					authorization: 'Bearer ok',
					'content-type': 'application/json',
				},
				body: 'not json{{{',
			});
			const res = await handleDayNotes(req, {
				admin,
				verifyJwt: vi.fn().mockResolvedValue('user-123'),
			});
			expect(res.status).toBe(400);
		});

		it('deletes the note when note is empty', async () => {
			const admin = makeAdmin();
			const res = await handleDayNotes(
				makeRequest(
					'PUT',
					{ authorization: 'Bearer ok' },
					{ date: '2026-07-15', note: '   ' },
				),
				{
					admin,
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				deleted: true,
				date: '2026-07-15',
			});
			expect(admin.deleteDayNote).toHaveBeenCalledWith(
				'user-123',
				'2026-07-15',
			);
			expect(admin.upsertDayNote).not.toHaveBeenCalled();
		});
	});

	describe('DELETE /api/day-notes', () => {
		it('deletes a note and returns confirmation', async () => {
			const admin = makeAdmin();
			const res = await handleDayNotes(
				makeRequest(
					'DELETE',
					{ authorization: 'Bearer ok' },
					{ date: '2026-07-15' },
				),
				{
					admin,
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				deleted: true,
				date: '2026-07-15',
			});
			expect(admin.deleteDayNote).toHaveBeenCalledWith(
				'user-123',
				'2026-07-15',
			);
		});

		it('returns 400 when date is missing', async () => {
			const admin = makeAdmin();
			const res = await handleDayNotes(
				makeRequest(
					'DELETE',
					{ authorization: 'Bearer ok' },
					{},
				),
				{
					admin,
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(400);
			expect(admin.deleteDayNote).not.toHaveBeenCalled();
		});

		it('returns 400 when date format is invalid', async () => {
			const admin = makeAdmin();
			const res = await handleDayNotes(
				makeRequest(
					'DELETE',
					{ authorization: 'Bearer ok' },
					{ date: 'bad-date' },
				),
				{
					admin,
					verifyJwt: vi.fn().mockResolvedValue('user-123'),
				},
			);
			expect(res.status).toBe(400);
		});
	});

	describe('OPTIONS preflight', () => {
		it('returns 204 for OPTIONS requests', async () => {
			const res = await handleDayNotes(
				new Request('https://hoursmith.io/api/day-notes', {
					method: 'OPTIONS',
				}),
			);
			expect(res.status).toBe(204);
		});
	});
});
