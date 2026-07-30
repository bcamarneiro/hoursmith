/**
 * GitLab Push Hook ingestion endpoint.
 *
 * `POST /api/queue/ingest` accepts a GitLab Push Hook JSON payload,
 * validates it, and persists a row to `raw_commits` for downstream
 * async processing. Returns 202 Accepted with the inserted row id.
 *
 * Only `refs/heads/` (branch pushes) are accepted — tag pushes and
 * other refs are rejected with 400.
 *
 * Security note: GitLab webhooks don't carry our JWT, so this endpoint
 * is intentionally NOT auth-protected. Security relies on webhook URL
 * secrecy and optional IP allowlisting (future improvement).
 *
 * Linear: ADA-631.
 */

import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';

export const config = {
	runtime: 'edge',
};

export interface IngestDeps {
	admin?: SupabaseAdminClient;
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

	// Compute pushed_at — use latest commit timestamp, fallback to now
	const commits = Array.isArray(body.commits) ? (body.commits as Record<string, unknown>[]) : [];
	const pushedAt =
		commits.length > 0 && typeof commits[commits.length - 1]?.timestamp === 'string'
			? (commits[commits.length - 1].timestamp as string)
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

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
