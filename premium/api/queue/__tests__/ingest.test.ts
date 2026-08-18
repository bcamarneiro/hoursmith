/**
 * Unit tests for `POST /api/queue/ingest`.
 *
 * Tests validation logic and error handling via the injected deps surface.
 *
 * Linear: ADA-631, ADA-633.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handleIngest, type EnqueueFn, type IngestDeps } from '../ingest';

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

function nonPostRequest(): Request {
	return new Request('https://hoursmith.io/api/queue/ingest', { method: 'GET' });
}

function makeAdmin(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		insertRawCommit: vi.fn().mockResolvedValue({ id: 42 }),
		...overrides,
	} as unknown as SupabaseAdminClient;
}

function makeEnqueue(): EnqueueFn {
	return vi.fn().mockResolvedValue(undefined);
}

/** Minimal deps that prevent the real `defaultEnqueue` from firing. */
function makeDeps(overrides: Partial<IngestDeps> = {}): IngestDeps {
	return { admin: makeAdmin(), enqueue: makeEnqueue(), ...overrides };
}

const validPayload: Record<string, unknown> = {
	object_kind: 'push',
	project: { id: 123 },
	user_username: 'alice',
	ref: 'refs/heads/main',
	total_commits_count: 3,
	commits: [
		{ id: 'abc', message: 'fix', timestamp: '2026-07-30T12:00:00Z' },
		{ id: 'def', message: 'feat', timestamp: '2026-07-30T13:00:00Z' },
		{ id: 'ghi', message: 'docs', timestamp: '2026-07-30T14:00:00Z' },
	],
};

describe('POST /api/queue/ingest', () => {
	it('returns 405 for non-POST methods', async () => {
		const deps = makeDeps();
		const res = await handleIngest(nonPostRequest(), deps);
		expect(res.status).toBe(405);
		const body = await res.json();
		expect(body).toEqual({ error: 'method_not_allowed' });
		expect(deps.admin?.insertRawCommit).not.toHaveBeenCalled();
	});

	it('returns 400 for invalid JSON', async () => {
		const req = new Request('https://hoursmith.io/api/queue/ingest', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not-json',
		});
		const deps = makeDeps();
		const res = await handleIngest(req, deps);
		expect(res.status).toBe(400);
		expect(deps.admin?.insertRawCommit).not.toHaveBeenCalled();
	});

	it('returns 400 when object_kind is not push', async () => {
		const deps = makeDeps();
		const res = await handleIngest(
			makeRequest({ ...validPayload, object_kind: 'tag_push' }),
			deps,
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toEqual({ error: 'not_a_push_event' });
		expect(deps.admin?.insertRawCommit).not.toHaveBeenCalled();
	});

	it('returns 400 when required fields are missing', async () => {
		const deps = makeDeps();
		const res = await handleIngest(
			makeRequest({ object_kind: 'push' }),
			deps,
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toEqual({ error: 'missing_required_fields' });
		expect(deps.admin?.insertRawCommit).not.toHaveBeenCalled();
	});

	it('returns 400 for tag refs (non-branch)', async () => {
		const deps = makeDeps();
		const res = await handleIngest(
			makeRequest({
				...validPayload,
				ref: 'refs/tags/v1.0',
			}),
			deps,
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toEqual({ error: 'ref_not_supported' });
		expect(deps.admin?.insertRawCommit).not.toHaveBeenCalled();
	});

	it('returns 202 and inserts raw commit for a valid push', async () => {
		const deps = makeDeps();
		const res = await handleIngest(makeRequest(validPayload), deps);
		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body).toEqual({ id: 42 });
		expect(deps.admin?.insertRawCommit).toHaveBeenCalledWith({
			project_id: 123,
			user_username: 'alice',
			ref: 'refs/heads/main',
			commit_count: 3,
			pushed_at: '2026-07-30T12:00:00Z',
			payload: expect.objectContaining({ object_kind: 'push' }),
			status: 'pending',
		});
	});

	it('enqueues a job with the inserted row id after a successful insert', async () => {
		const enqueue = makeEnqueue();
		const deps = makeDeps({ enqueue });
		const res = await handleIngest(makeRequest(validPayload), deps);
		expect(res.status).toBe(202);
		expect(enqueue).toHaveBeenCalledWith({
			rawCommitId: 42,
			projectId: 123,
			userUsername: 'alice',
			ref: 'refs/heads/main',
		});
	});

	it('still returns 202 even when enqueue fails (fire-and-forget)', async () => {
		const enqueue = vi.fn().mockRejectedValue(new Error('Redis down'));
		const deps = makeDeps({ enqueue });
		const res = await handleIngest(makeRequest(validPayload), deps);
		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body).toEqual({ id: 42 });
		// DB insert still happened
		expect(deps.admin?.insertRawCommit).toHaveBeenCalled();
		// Enqueue was attempted
		expect(enqueue).toHaveBeenCalled();
	});

	it('falls back to commits.length when total_commits_count is absent', async () => {
		const deps = makeDeps();
		const { total_commits_count: _, ...noTotal } = validPayload;
		const res = await handleIngest(makeRequest(noTotal), deps);
		expect(res.status).toBe(202);
		expect(deps.admin?.insertRawCommit).toHaveBeenCalledWith(
			expect.objectContaining({ commit_count: 3 }),
		);
	});

	it('falls back to ISO now when commits array is empty or has no timestamp', async () => {
		const deps = makeDeps();
		const res = await handleIngest(
			makeRequest({
				...validPayload,
				total_commits_count: 0,
				commits: [],
			}),
			deps,
		);
		expect(res.status).toBe(202);
		const calledWith = (deps.admin?.insertRawCommit as ReturnType<typeof vi.fn>)
			.mock.calls[0][0];
		expect(calledWith.commit_count).toBe(0);
		// pushed_at should be a valid ISO string (current time fallback)
		expect(() => new Date(calledWith.pushed_at)).not.toThrow();
	});

	it('returns 500 when DB insert fails', async () => {
		const deps = makeDeps({
			admin: makeAdmin({
				insertRawCommit: vi
					.fn()
					.mockRejectedValue(new Error('db connection error')),
			}),
		});
		const res = await handleIngest(makeRequest(validPayload), deps);
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body).toEqual({ error: 'internal_error' });
	});
});
