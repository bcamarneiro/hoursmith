/**
 * Unit tests for `POST /api/cron/absence-poll` (ADA-604).
 *
 * Covers auth guard (cron secret), empty-state early return, feed processing
 * with assignments, and per-feed error tolerance.
 *
 * Linear: ADA-604.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../../_lib/supabaseAdmin';
import type { AbsenceEvent } from '../../../_lib/icsParser';
import { handleAbsencePoll } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
	headers: Record<string, string> = {},
	method = 'POST',
): Request {
	return new Request('https://hoursmith.io/api/cron/absence-poll', {
		method,
		headers,
	});
}

// ---------------------------------------------------------------------------
// Stub data
// ---------------------------------------------------------------------------

const PROFILE_ALICE = { id: 'user-alice', email: 'alice@example.com', created_at: '2025-01-01T00:00:00Z' };
const PROFILE_BOB = { id: 'user-bob', email: 'bob@example.com', created_at: '2025-01-01T00:00:00Z' };

const ABSENCE_FEED = {
	id: 'feed-1',
	user_id: 'user-alice',
	url: 'https://example.com/absence.ics',
	type: 'absence' as const,
	label: 'Engineering',
	absence_attribution: 'self' as const,
	title_filter: null,
	enabled: true,
	created_at: '2025-01-01T00:00:00Z',
	updated_at: '2025-01-01T00:00:00Z',
};

const HOLIDAY_FEED = {
	id: 'feed-2',
	user_id: 'user-alice',
	url: 'https://example.com/holidays.ics',
	type: 'holiday' as const,
	label: 'US Holidays',
	absence_attribution: null,
	title_filter: null,
	enabled: true,
	created_at: '2025-01-01T00:00:00Z',
	updated_at: '2025-01-01T00:00:00Z',
};

function makeAdmin(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		getUserIdFromToken: vi.fn(),
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
		getProfile: vi.fn(),
		getAllEnabledFeeds: vi.fn().mockResolvedValue([]),
		getAllProfiles: vi.fn().mockResolvedValue([]),
		getAbsenceAssignments: vi.fn().mockResolvedValue([]),
		replaceAbsenceRecords: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// The "now" we pin so range strings are deterministic
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-20T12:00:00Z');

describe('POST /api/cron/absence-poll', () => {
	it('rejects non-POST methods (405)', async () => {
		const admin = makeAdmin();
		const res = await handleAbsencePoll(makeRequest({}, 'GET'), { supabase: admin, now: NOW });
		expect(res.status).toBe(405);
		const body = await res.json();
		expect(body.error).toBe('method_not_allowed');
		expect(admin.getAllEnabledFeeds).not.toHaveBeenCalled();
	});

	it('rejects invalid cron secret (403)', async () => {
		vi.stubEnv('CRON_SECRET', 'my-secret');
		const admin = makeAdmin();
		const res = await handleAbsencePoll(
			makeRequest({ 'x-vercel-cron': 'wrong' }),
			{ supabase: admin, now: NOW },
		);
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toBe('invalid_cron_secret');
		vi.unstubAllEnvs();
	});

	it('returns ok with 0 feeds when no enabled feeds exist', async () => {
		const admin = makeAdmin({
			getAllEnabledFeeds: vi.fn().mockResolvedValue([]),
		});
		const res = await handleAbsencePoll(makeRequest(), { supabase: admin, now: NOW });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true, feedsProcessed: 0 });
	});

	it('processes self-attributed absence feeds', async () => {
		const admin = makeAdmin({
			getAllEnabledFeeds: vi.fn().mockResolvedValue([ABSENCE_FEED]),
			getAllProfiles: vi.fn().mockResolvedValue([PROFILE_ALICE]),
			getAbsenceAssignments: vi.fn().mockResolvedValue([]),
			replaceAbsenceRecords: vi.fn().mockResolvedValue(undefined),
		});

		const fakeEvent: AbsenceEvent = {
			summary: 'Sick day',
			dtstart: '20260720',
			dtend: '20260721',
			rrule: '',
			exdates: [],
		};

		const res = await handleAbsencePoll(makeRequest(), {
			supabase: admin,
			now: NOW,
			fetchAndParseFeed: vi.fn().mockResolvedValue({ events: [fakeEvent] }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.feedsProcessed).toBe(1);
		expect(body.feedErrors).toBe(0);
		expect(body.totalRecords).toBeGreaterThan(0);

		// Verify the DB write was called for the resolved user
		expect(admin.replaceAbsenceRecords).toHaveBeenCalledOnce();
		const callArgs = (admin.replaceAbsenceRecords as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(callArgs[0]).toBe('user-alice'); // user_id
		// records should contain the sick day entry
		const records = callArgs[3] as unknown[];
		expect(records.length).toBeGreaterThan(0);
		expect(records[0]).toMatchObject({
			user_id: 'user-alice',
			kind: 'sick',
			source: 'cron',
		});
	});

	it('processes holiday feeds and fans out to all users', async () => {
		const admin = makeAdmin({
			getAllEnabledFeeds: vi.fn().mockResolvedValue([HOLIDAY_FEED]),
			getAllProfiles: vi.fn().mockResolvedValue([PROFILE_ALICE, PROFILE_BOB]),
			getAbsenceAssignments: vi.fn().mockResolvedValue([]),
			replaceAbsenceRecords: vi.fn().mockResolvedValue(undefined),
		});

		const fakeEvent: AbsenceEvent = {
			summary: 'Independence Day',
			dtstart: '20260721',
			dtend: '20260722',
			rrule: '',
			exdates: [],
		};

		const res = await handleAbsencePoll(makeRequest(), {
			supabase: admin,
			now: NOW,
			fetchAndParseFeed: vi.fn().mockResolvedValue({ events: [fakeEvent] }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.feedsProcessed).toBe(1);
		expect(body.feedErrors).toBe(0);

		// Holiday without assignments should fan out to every user
		expect(admin.replaceAbsenceRecords).toHaveBeenCalledTimes(2);

		// Verify alice got the holiday record
		const aliceCall = (admin.replaceAbsenceRecords as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === 'user-alice',
		);
		expect(aliceCall).toBeDefined();
		const aliceRecords = aliceCall![3] as unknown[];
		expect(aliceRecords[0]).toMatchObject({
			user_id: 'user-alice',
			kind: 'holiday',
		});

		// Verify bob got the holiday record
		const bobCall = (admin.replaceAbsenceRecords as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === 'user-bob',
		);
		expect(bobCall).toBeDefined();
		const bobRecords = bobCall![3] as unknown[];
		expect(bobRecords[0]).toMatchObject({
			user_id: 'user-bob',
			kind: 'holiday',
		});
	});

	it('tolerates a feed fetch failure without failing the entire run', async () => {
		const admin = makeAdmin({
			getAllEnabledFeeds: vi.fn().mockResolvedValue([ABSENCE_FEED]),
			getAllProfiles: vi.fn().mockResolvedValue([PROFILE_ALICE]),
			getAbsenceAssignments: vi.fn().mockResolvedValue([]),
			replaceAbsenceRecords: vi.fn().mockResolvedValue(undefined),
		});

		const res = await handleAbsencePoll(makeRequest(), {
			supabase: admin,
			now: NOW,
			fetchAndParseFeed: vi.fn().mockResolvedValue(null),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.feedsProcessed).toBe(1);
		expect(body.feedErrors).toBe(1);
		expect(body.totalRecords).toBe(0);
		// No database write since the feed errored
		expect(admin.replaceAbsenceRecords).not.toHaveBeenCalled();
	});

	it('returns 500 on unexpected Supabase error', async () => {
		const admin = makeAdmin({
			getAllEnabledFeeds: vi.fn().mockRejectedValue(new Error('DB connection failed')),
		});

		const res = await handleAbsencePoll(makeRequest(), { supabase: admin, now: NOW });
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error).toBe('internal_error');
	});

	it('processes shared-attribution absence feeds via assignment patterns', async () => {
		const SHARED_FEED = {
			id: 'feed-3',
			user_id: 'user-alice',
			url: 'https://example.com/shared.ics',
			type: 'absence' as const,
			label: 'Team',
			absence_attribution: 'shared' as const,
			title_filter: null,
			enabled: true,
			created_at: '2025-01-01T00:00:00Z',
			updated_at: '2025-01-01T00:00:00Z',
		};

		const admin = makeAdmin({
			getAllEnabledFeeds: vi.fn().mockResolvedValue([SHARED_FEED]),
			getAllProfiles: vi.fn().mockResolvedValue([PROFILE_ALICE, PROFILE_BOB]),
			getAbsenceAssignments: vi.fn().mockResolvedValue([
				{
					id: 'assign-1',
					user_id: 'user-alice',
					pattern: 'bob',
					user_emails: ['bob@example.com'],
					created_at: '2025-01-01T00:00:00Z',
					updated_at: '2025-01-01T00:00:00Z',
				},
			]),
			replaceAbsenceRecords: vi.fn().mockResolvedValue(undefined),
		});

		const fakeEvent: AbsenceEvent = {
			summary: 'Bob vacation',
			dtstart: '20260721',
			dtend: '20260722',
			rrule: '',
			exdates: [],
		};

		const res = await handleAbsencePoll(makeRequest(), {
			supabase: admin,
			now: NOW,
			fetchAndParseFeed: vi.fn().mockResolvedValue({ events: [fakeEvent] }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.feedsProcessed).toBe(1);
		expect(body.feedErrors).toBe(0);
		expect(body.totalRecords).toBeGreaterThan(0);

		// Shared event matching "bob" → written to bob only, not alice
		expect(admin.replaceAbsenceRecords).toHaveBeenCalledTimes(1);
		const callArgs = (admin.replaceAbsenceRecords as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(callArgs[0]).toBe('user-bob');
		const records = callArgs[3] as unknown[];
		expect(records.length).toBe(1);
		expect(records[0]).toMatchObject({
			user_id: 'user-bob',
			summary: expect.stringContaining('Bob vacation') as unknown,
			kind: 'vacation',
			source: 'cron',
		});
	});
});
