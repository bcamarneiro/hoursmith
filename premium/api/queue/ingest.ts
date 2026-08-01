/**
 * GitLab Push Hook ingestion endpoint.
 *
 * `POST /api/queue/ingest` accepts a GitLab Push Hook JSON payload,
 * validates it, persists a row to `raw_commits`, and enqueues a
 * BullMQ job for downstream async processing (profile linking,
 * commit-user linking). Returns 202 Accepted with the inserted row id.
 *
 * Only `refs/heads/` (branch pushes) are accepted — tag pushes and
 * other refs are rejected with 400.
 *
 * Security note: GitLab webhooks don't carry our JWT, so this endpoint
 * is intentionally NOT auth-protected. Security relies on webhook URL
 * secrecy and optional IP allowlisting (future improvement).
 *
 * Linear: ADA-631, ADA-633.
 */

import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';
import type { RawCommitJob } from '../_lib/queueProvider.js';

export const config = {
	runtime: 'edge',
};

export interface EnqueuePayload {
	rawCommitId: number;
	projectId: number;
	userUsername: string;
	ref: string;
}

export type EnqueueFn = (payload: EnqueuePayload) => Promise<void>;

export interface IngestDeps {
	admin?: SupabaseAdminClient;
	/** Enqueue a job for downstream processing. Injected so tests can stub it. */
	enqueue?: EnqueueFn;
}

export default async function handler(request: Request): Promise<Response> {
	return handleIngest(request);
}

export async function handleIngest(
	request: Request,
	deps: IngestDeps = {},
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return jsonResponse(400, { error: 'invalid_json' });
	}

	// Validate it's a GitLab Push Hook
	if (body.object_kind !== 'push') {
		return jsonResponse(400, { error: 'not_a_push_event' });
	}

	// Validate required fields
	const project = body.project as Record<string, unknown> | undefined;
	const projectId = project?.id;
	const userUsername = body.user_username;
	const ref = body.ref;

	if (typeof projectId !== 'number' || typeof userUsername !== 'string' || typeof ref !== 'string') {
		return jsonResponse(400, { error: 'missing_required_fields' });
	}

	// Only accept branch refs (refs/heads/*)
	if (!ref.startsWith('refs/heads/')) {
		return jsonResponse(400, { error: 'ref_not_supported' });
	}

	// Compute commit count — fallback when total_commits_count absent
	const commitCount =
		typeof body.total_commits_count === 'number'
			? (body.total_commits_count as number)
			: Array.isArray(body.commits)
				? (body.commits as unknown[]).length
				: 0;

	// Compute pushed_at — use latest commit timestamp, fallback to now.
	// GitLab Push Hook orders commits newest-first; commits[0] is the most recent.
	const commits = Array.isArray(body.commits) ? (body.commits as Record<string, unknown>[]) : [];
	const pushedAt =
		commits.length > 0 && typeof commits[0]?.timestamp === 'string'
			? (commits[0].timestamp as string)
			: new Date().toISOString();

	let admin: SupabaseAdminClient;
	try {
		admin = deps.admin ?? defaultSupabaseAdmin();
	} catch (err) {
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				svc: 'hoursmith-ingest',
				event: 'ingest',
				status: 500,
				note: `server_misconfigured:${(err as Error).message}`,
			}),
		);
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	try {
		const { id } = await admin.insertRawCommit({
			project_id: projectId,
			user_username: userUsername,
			ref,
			commit_count: commitCount,
			pushed_at: pushedAt,
			payload: body,
			status: 'pending',
		});

		const enqueue = deps.enqueue ?? defaultEnqueue;
		// Fire-and-forget: the row is persisted; enqueue failure is logged but
		// does not fail the webhook response.
		enqueue({
			rawCommitId: id,
			projectId,
			userUsername: userUsername as string,
			ref: ref as string,
		}).catch((enqueueErr: Error) => {
			console.log(
				JSON.stringify({
					ts: new Date().toISOString(),
					svc: 'hoursmith-ingest',
					event: 'enqueue_failed',
					rawCommitId: id,
					note: enqueueErr.message,
				}),
			);
		});

		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				svc: 'hoursmith-ingest',
				event: 'ingest',
				status: 202,
				note: `inserted raw_commit ${id} for project ${projectId}`,
			}),
		);

		return jsonResponse(202, { id });
	} catch (err) {
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				svc: 'hoursmith-ingest',
				event: 'ingest',
				status: 500,
				note: `db_insert_failed:${(err as Error).message}`,
			}),
		);
		return jsonResponse(500, { error: 'internal_error' });
	}
}

/**
 * Default enqueue implementation that creates a BullMQ job via the
 * process-wide `raw-commits` queue singleton.  Lazy-imports so that
 * tests and serverless endpoints that inject their own `enqueue` never
 * touch BullMQ.
 */
async function defaultEnqueue(payload: EnqueuePayload): Promise<void> {
	const { getRawCommitsQueue } = await import('../_lib/queueProvider.js');
	const queue = getRawCommitsQueue();
	await queue.add('raw-commits', payload satisfies RawCommitJob);
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
