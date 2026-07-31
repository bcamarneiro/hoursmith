/**
 * Unit tests for `GET /api/queue/schedule` (ADA-700).
 *
 * The BullMQ queue is injected as a mock with the same `add` shape as a real
 * `Queue`, and the Supabase admin client is injected too, so the tests
 * exercise the sweep/claim/enqueue wiring without Redis or the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';

import type { RawCommitJob } from '../../_lib/queueProvider.js';
import { RAW_COMMIT_JOB_NAME } from '../../_lib/queueProvider.js';
import type {
	RawCommitRow,
	SupabaseAdminClient,
} from '../../_lib/supabaseAdmin.js';
import { handleSchedule } from '../schedule.js';

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request('https://hoursmith.io/api/queue/schedule', {
		method: 'GET',
		headers,
	});
}

function makeAdmin(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		listPendingRawCommits: vi.fn().mockResolvedValue([]),
		claimRawCommitForQueue: vi.fn().mockResolvedValue(true),
		revertRawCommitToPending: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as SupabaseAdminClient;
}

function makeQueue(): Queue<RawCommitJob> {
	return {
		add: vi.fn().mockResolvedValue(undefined),
	} as unknown as Queue<RawCommitJob>;
}

function pendingRow(overrides: Partial<RawCommitRow> = {}): RawCommitRow {
	return {
		id: 7,
		project_id: 123,
		user_username: 'alice',
		ref: 'refs/heads/main',
		commit_count: 3,
		pushed_at: '2026-07-30T12:00:00Z',
		payload: { object_kind: 'push' },
		status: 'pending',
		created_at: '2026-07-30T12:00:00Z',
		...overrides,
	};
}

beforeEach(() => {
	vi.stubEnv('CRON_SECRET', 'test-secret');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe('GET /api/queue/schedule', () => {
	it('returns 405 for methods other than GET/POST', async () => {
		const admin = makeAdmin();
		const req = new Request('https://hoursmith.io/api/queue/schedule', {
			method: 'PUT',
		});
		const res = await handleSchedule(req, { admin });
		expect(res.status).toBe(405);
		expect(await res.json()).toEqual({ error: 'method_not_allowed' });
		expect(admin.listPendingRawCommits).not.toHaveBeenCalled();
	});

	it('returns 500 when CRON_SECRET is not configured', async () => {
		vi.stubEnv('CRON_SECRET', '');
		const res = await handleSchedule(makeRequest(), {
			admin: makeAdmin(),
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'server_misconfigured' });
	});

	it('returns 401 when the authorization header is missing or wrong', async () => {
		const admin = makeAdmin();
		const missing = await handleSchedule(makeRequest(), { admin });
		expect(missing.status).toBe(401);

		const wrong = await handleSchedule(
			makeRequest({ authorization: 'Bearer nope' }),
			{ admin },
		);
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toEqual({ error: 'unauthorized' });
		expect(admin.listPendingRawCommits).not.toHaveBeenCalled();
	});

	it('returns 500 when the admin client cannot be constructed', async () => {
		const res = await handleSchedule(
			makeRequest({ authorization: 'Bearer test-secret' }),
			// No admin injected and no SUPABASE_* env vars in tests, so
			// defaultSupabaseAdmin() throws.
			{},
		);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'server_misconfigured' });
	});

	it('reports enqueued 0 and adds nothing when there are no pending rows', async () => {
		const admin = makeAdmin();
		const queue = makeQueue();
		const res = await handleSchedule(
			makeRequest({ authorization: 'Bearer test-secret' }),
			{ admin, queue },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ enqueued: 0 });
		expect(admin.listPendingRawCommits).toHaveBeenCalledWith(100);
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('claims each pending row and enqueues one job per row', async () => {
		const admin = makeAdmin({
			listPendingRawCommits: vi.fn().mockResolvedValue([
				pendingRow({ id: 7 }),
				pendingRow({
					id: 8,
					project_id: 456,
					user_username: 'bob',
					ref: 'refs/heads/dev',
				}),
			]),
		});
		const queue = makeQueue();
		const res = await handleSchedule(
			makeRequest({ authorization: 'Bearer test-secret' }),
			{ admin, queue },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ enqueued: 2 });
		expect(admin.claimRawCommitForQueue).toHaveBeenCalledWith(7);
		expect(admin.claimRawCommitForQueue).toHaveBeenCalledWith(8);
		expect(queue.add).toHaveBeenCalledTimes(2);
		expect(queue.add).toHaveBeenCalledWith(
			RAW_COMMIT_JOB_NAME,
			{
				rawCommitId: 7,
				projectId: 123,
				userUsername: 'alice',
				ref: 'refs/heads/main',
			},
			{ jobId: 'raw-commit-7' },
		);
	});

	it('skips rows another invocation already claimed', async () => {
		const admin = makeAdmin({
			listPendingRawCommits: vi
				.fn()
				.mockResolvedValue([pendingRow({ id: 7 }), pendingRow({ id: 8 })]),
			claimRawCommitForQueue: vi.fn().mockResolvedValue(false),
		});
		const queue = makeQueue();
		const res = await handleSchedule(
			makeRequest({ authorization: 'Bearer test-secret' }),
			{ admin, queue },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ enqueued: 0 });
		expect(queue.add).not.toHaveBeenCalled();
	});

	it('reverts the claim and keeps going when enqueueing a row fails', async () => {
		const admin = makeAdmin({
			listPendingRawCommits: vi
				.fn()
				.mockResolvedValue([pendingRow({ id: 7 }), pendingRow({ id: 8 })]),
		});
		const add = vi
			.fn()
			.mockRejectedValueOnce(new Error('redis connection refused'))
			.mockResolvedValue(undefined);
		const queue = { add } as unknown as Queue<RawCommitJob>;
		const res = await handleSchedule(
			makeRequest({ authorization: 'Bearer test-secret' }),
			{ admin, queue },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ enqueued: 1 });
		expect(admin.revertRawCommitToPending).toHaveBeenCalledWith(7);
		expect(admin.revertRawCommitToPending).not.toHaveBeenCalledWith(8);
		expect(add).toHaveBeenCalledTimes(2);
	});

	it('returns 500 when the pending-row sweep fails', async () => {
		const admin = makeAdmin({
			listPendingRawCommits: vi
				.fn()
				.mockRejectedValue(new Error('db connection error')),
		});
		const queue = makeQueue();
		const res = await handleSchedule(
			makeRequest({ authorization: 'Bearer test-secret' }),
			{ admin, queue },
		);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'internal_error' });
		expect(queue.add).not.toHaveBeenCalled();
	});
});
