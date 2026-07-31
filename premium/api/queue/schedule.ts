/**
 * Cron scheduler for the raw-commits queue (ADA-700).
 *
 * Vercel Cron fires `GET /api/queue/schedule` every 5 minutes (see
 * vercel.json). Each tick sweeps `raw_commits` rows still in `pending` and
 * enqueues one BullMQ job per row through the shared queue provider
 * (ADA-695/698), so consumers of the `raw-commits` queue process webhooks
 * without any always-on worker.
 *
 * Delivery semantics:
 * - Concurrency: rows are claimed with a guarded PATCH (`status=eq.pending`),
 *   so overlapping cron invocations never enqueue the same row twice.
 * - Failures: if enqueueing fails after a claim, the claim is reverted to
 *   `pending` and a later tick retries the row (at-least-once; consumers
 *   must be idempotent).
 *
 * Security: only Vercel's cron runner may invoke this. When the `CRON_SECRET`
 * env var is set, Vercel signs cron requests with `Authorization: Bearer
 * <CRON_SECRET>`; the handler requires that exact header.
 *
 * Linear: ADA-700.
 */

import type { Queue } from 'bullmq';

import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';
import {
	getRawCommitsQueue,
	RAW_COMMIT_JOB_NAME,
	type RawCommitJob,
} from '../_lib/queueProvider.js';

export const config = {
	// BullMQ (ioredis) needs Node's socket stack; the Edge runtime cannot talk
	// to Redis.
	runtime: 'nodejs',
};

/** Max rows enqueued per tick — keeps a single invocation inside the Vercel function budget. */
const MAX_BATCH = 100;

export interface ScheduleDeps {
	admin?: SupabaseAdminClient;
	queue?: Queue<RawCommitJob>;
}

export default async function handler(request: Request): Promise<Response> {
	return handleSchedule(request);
}

export async function handleSchedule(
	request: Request,
	deps: ScheduleDeps = {},
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const secret = process.env.CRON_SECRET;
	if (!secret) {
		// No secret configured: every cron request would be rejected anyway.
		// Fail loudly instead of silently no-op'ing the pipeline.
		return jsonResponse(500, { error: 'server_misconfigured' });
	}
	if (request.headers.get('authorization') !== `Bearer ${secret}`) {
		return jsonResponse(401, { error: 'unauthorized' });
	}

	let admin: SupabaseAdminClient;
	try {
		admin = deps.admin ?? defaultSupabaseAdmin();
	} catch (_err) {
		return jsonResponse(500, {
			error: 'server_misconfigured',
		});
	}

	const queue = deps.queue ?? getRawCommitsQueue();

	try {
		const pending = await admin.listPendingRawCommits(MAX_BATCH);
		let enqueued = 0;
		for (const row of pending) {
			if (row.id === undefined) {
				// Rows come from the DB so this should never happen; skip rather
				// than enqueue a payload we could not reference back to a row.
				console.log(logLine('schedule', 500, 'row_without_id_skipped'));
				continue;
			}
			const claimed = await admin.claimRawCommitForQueue(row.id);
			if (!claimed) {
				// A concurrent tick got there first.
				continue;
			}
			try {
				await queue.add(
					RAW_COMMIT_JOB_NAME,
					{
						rawCommitId: row.id,
						projectId: row.project_id,
						userUsername: row.user_username,
						ref: row.ref,
					},
					{ jobId: `raw-commit-${row.id}` },
				);
				enqueued += 1;
			} catch (err) {
				// Undo the claim so the row is retried by a later tick.
				console.log(
					logLine('schedule', 500, `enqueue_failed:${(err as Error).message}`),
				);
				await admin.revertRawCommitToPending(row.id);
			}
		}
		console.log(
			logLine(
				'schedule',
				200,
				`enqueued ${enqueued}/${pending.length} raw-commits jobs`,
			),
		);
		return jsonResponse(200, { enqueued });
	} catch (err) {
		console.log(
			logLine('schedule', 500, `sweep_failed:${(err as Error).message}`),
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

function logLine(event: string, status: number, note: string): string {
	return JSON.stringify({
		ts: new Date().toISOString(),
		svc: 'hoursmith-schedule',
		event,
		status,
		note,
	});
}
