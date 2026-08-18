/**
 * Integration tests for the full ingestion pipeline (ADA-633).
 *
 * Exercises the end-to-end webhook → DB insert → queue enqueue chain.
 * Uses injected fakes for both the Supabase admin client and the
 * BullMQ queue — no real Redis or Postgres needed.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handleIngest, type EnqueueFn, type EnqueuePayload } from '../ingest';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(
	body: Record<string, unknown> | null,
	headers: Record<string, string> = {},
): Request {
	return new Request('https://hoursmith.io/api/queue/ingest', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: body !== null ? JSON.stringify(body) : undefined,
	});
}

function makeAdmin(id = 42): SupabaseAdminClient {
	return {
		insertRawCommit: vi.fn().mockResolvedValue({ id }),
	} as unknown as SupabaseAdminClient;
}

/** An enqueue spy that captures every call. */
function makeCapturingEnqueue(): {
	fn: EnqueueFn;
	calls: EnqueuePayload[];
} {
	const calls: EnqueuePayload[] = [];
	const fn = vi.fn().mockImplementation(async (p: EnqueuePayload) => {
		calls.push({ ...p });
	});
	return { fn, calls };
}

function pushPayload(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		object_kind: 'push',
		project: { id: 123, name: 'hoursmith' },
		user_username: 'alice',
		ref: 'refs/heads/main',
		total_commits_count: 3,
		commits: [
			{
				id: 'abc',
				message: 'fix: patch issue',
				timestamp: '2026-07-30T12:00:00Z',
			},
			{
				id: 'def',
				message: 'feat: new endpoint',
				timestamp: '2026-07-30T13:00:00Z',
			},
			{
				id: 'ghi',
				message: 'docs: update readme',
				timestamp: '2026-07-30T14:00:00Z',
			},
		],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Ingestion pipeline (integration)', () => {
	it('completes the full insert → enqueue chain', async () => {
		const admin = makeAdmin();
		const { fn: enqueue, calls } = makeCapturingEnqueue();
		const res = await handleIngest(makeRequest(pushPayload()), {
			admin,
			enqueue,
		});

		// 1. Webhook accepted
		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body.id).toBe(42);

		// 2. DB row inserted with correct fields
		expect(admin.insertRawCommit).toHaveBeenCalledTimes(1);
		expect(admin.insertRawCommit).toHaveBeenCalledWith(
			expect.objectContaining({
				project_id: 123,
				user_username: 'alice',
				ref: 'refs/heads/main',
				status: 'pending',
			}),
		);

		// 3. Queue job enqueued with the returned row id
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(calls[0]).toEqual({
			rawCommitId: 42,
			projectId: 123,
			userUsername: 'alice',
			ref: 'refs/heads/main',
		});
	});

	it('passes the correct row id to the queue job (not a hardcoded value)', async () => {
		const admin = makeAdmin(77);
		const { fn: enqueue, calls } = makeCapturingEnqueue();
		await handleIngest(makeRequest(pushPayload()), { admin, enqueue });

		expect(calls[0].rawCommitId).toBe(77);
	});

	it('enqueues a distinct job for each distinct push', async () => {
		const admin = {
			insertRawCommit: vi
				.fn()
				.mockResolvedValueOnce({ id: 1 })
				.mockResolvedValueOnce({ id: 2 })
				.mockResolvedValueOnce({ id: 3 }),
		} as unknown as SupabaseAdminClient;
		const { fn: enqueue, calls } = makeCapturingEnqueue();

		// Push 1: main branch
		await handleIngest(makeRequest(pushPayload({ ref: 'refs/heads/main' })), {
			admin,
			enqueue,
		});
		// Push 2: feature branch
		await handleIngest(
			makeRequest(pushPayload({ ref: 'refs/heads/feat/new' })),
			{ admin, enqueue },
		);
		// Push 3: another project
		await handleIngest(
			makeRequest(
				pushPayload({
					project: { id: 999 },
					ref: 'refs/heads/main',
				}),
			),
			{ admin, enqueue },
		);

		expect(enqueue).toHaveBeenCalledTimes(3);
		expect(calls.map((c) => c.rawCommitId)).toEqual([1, 2, 3]);
		expect(calls.map((c) => c.projectId)).toEqual([123, 123, 999]);
		expect(calls.map((c) => c.ref)).toEqual([
			'refs/heads/main',
			'refs/heads/feat/new',
			'refs/heads/main',
		]);
	});

	it('still returns 202 even when the queue is down (resilience)', async () => {
		const admin = makeAdmin();
		const enqueue = vi.fn().mockRejectedValue(new Error('Redis connection refused'));

		const res = await handleIngest(makeRequest(pushPayload()), {
			admin,
			enqueue,
		});

		// DB insert succeeded
		expect(admin.insertRawCommit).toHaveBeenCalledTimes(1);
		// Webhook still accepted the payload
		expect(res.status).toBe(202);
		// Enqueue was attempted
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it('propagates the pushed_at timestamp from the latest commit', async () => {
		const admin = makeAdmin();
		const { fn: enqueue } = makeCapturingEnqueue();
		await handleIngest(makeRequest(pushPayload()), { admin, enqueue });

		expect(admin.insertRawCommit).toHaveBeenCalledWith(
			expect.objectContaining({
				pushed_at: '2026-07-30T12:00:00Z',
			}),
		);
	});

	it('handles a push with 0 commits correctly', async () => {
		const admin = makeAdmin();
		const { fn: enqueue } = makeCapturingEnqueue();
		const res = await handleIngest(
			makeRequest(
				pushPayload({ total_commits_count: 0, commits: [] }),
			),
			{ admin, enqueue },
		);

		expect(res.status).toBe(202);
		expect(admin.insertRawCommit).toHaveBeenCalledWith(
			expect.objectContaining({ commit_count: 0 }),
		);
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it('handles a large push (50 commits) without issues', async () => {
		const admin = makeAdmin();
		const { fn: enqueue } = makeCapturingEnqueue();
		const manyCommits = Array.from({ length: 50 }, (_, i) => ({
			id: `commit-${i}`,
			message: `chore: batch ${i}`,
			timestamp: `2026-07-30T${String(i % 24).padStart(2, '0')}:00:00Z`,
		}));
		const res = await handleIngest(
			makeRequest(
				pushPayload({ total_commits_count: 50, commits: manyCommits }),
			),
			{ admin, enqueue },
		);

		expect(res.status).toBe(202);
		expect(admin.insertRawCommit).toHaveBeenCalledWith(
			expect.objectContaining({ commit_count: 50 }),
		);
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it('does NOT enqueue when the DB insert fails', async () => {
		const admin = makeAdmin();
		(admin.insertRawCommit as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('DB timeout'),
		);
		const enqueue = vi.fn();

		const res = await handleIngest(makeRequest(pushPayload()), {
			admin,
			enqueue,
		});

		expect(res.status).toBe(500);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('does NOT enqueue when validation rejects the payload', async () => {
		const admin = makeAdmin();
		const enqueue = vi.fn();

		// Missing required fields — should fail before touching DB or queue
		const res = await handleIngest(
			makeRequest({ object_kind: 'push' }),
			{ admin, enqueue },
		);

		expect(res.status).toBe(400);
		expect(admin.insertRawCommit).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
	});

	it('passes the full extractable user_username to the queue job', async () => {
		const admin = makeAdmin();
		const { fn: enqueue, calls } = makeCapturingEnqueue();

		await handleIngest(
			makeRequest(pushPayload({ user_username: 'bob' })),
			{ admin, enqueue },
		);

		expect(calls[0].userUsername).toBe('bob');
	});

	it('sends the correct ref to the queue job', async () => {
		const admin = makeAdmin();
		const { fn: enqueue, calls } = makeCapturingEnqueue();

		await handleIngest(
			makeRequest(pushPayload({ ref: 'refs/heads/release/v2' })),
			{ admin, enqueue },
		);

		expect(calls[0].ref).toBe('refs/heads/release/v2');
	});
});
