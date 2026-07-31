/**
 * Cron scheduler for premium background jobs (ADA-697).
 *
 * Syncs a `CronTask` registry (see `cron.ts`) into BullMQ Job Schedulers on
 * the queue the batch worker drains. The sync is idempotent: schedules are
 * upserted (create-or-update), and schedulers that no longer exist in the
 * registry are removed, so renaming or deleting a task actually takes effect
 * instead of leaving a zombie schedule in Redis.
 *
 * The scheduler is deliberately decoupled from the worker: schedules live in
 * Redis and fire whether or not a worker is running, and the batch worker
 * picks the resulting jobs up from the queue like any other. Run the sync at
 * deploy time (or on a slow cadence) via `worker/schedulerCli.ts`.
 *
 * Fail-loud policy: any Redis/scheduling error aborts the sync with a
 * `CronSchedulerError` naming the queue — a half-synced registry is worse
 * than a failed deploy, because it silently drops schedules.
 */

import type { Queue } from 'bullmq';

import type { CronTask } from './cron.js';

/** Raised when a schedule sync fails; carries the queue name for ops. */
export class CronSchedulerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CronSchedulerError';
	}
}

export interface SyncOptions {
	/** Log sink; defaults to `console.log`. */
	log?: (message: string, extra?: Record<string, unknown>) => void;
}

/** Log sink used when none is supplied. */
function defaultLog(message: string, extra?: Record<string, unknown>): void {
	const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
	console.log(`[scheduler] ${message}${suffix}`);
}

/**
 * Idempotently sync the task registry onto a queue's Job Schedulers.
 *
 * - Upserts every task (BullMQ's `upsertJobScheduler` is create-or-update).
 * - Removes schedulers whose id is not in the registry (stale/renamed tasks).
 * - Never logs job payloads — only ids, queues, patterns and timezones.
 *
 * @throws CronSchedulerError if any upsert/removal fails.
 */
export async function syncCronTasks(
	queue: Queue,
	tasks: readonly CronTask[],
	{ log = defaultLog }: SyncOptions = {},
): Promise<void> {
	let affected = 0;
	for (const task of tasks) {
		const jobName = task.jobName ?? task.id;
		const data = task.data ?? {};
		try {
			await queue.upsertJobScheduler(
				task.id,
				{ pattern: task.pattern, tz: task.timezone },
				{ name: jobName, data },
			);
			affected += 1;
			log('schedule upserted', {
				queue: queue.name,
				id: task.id,
				pattern: task.pattern,
				timezone: task.timezone ?? 'UTC',
				jobName,
			});
		} catch (error) {
			throw new CronSchedulerError(
				`failed to upsert schedule "${task.id}" on queue "${queue.name}": ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	const wanted = new Set(tasks.map((task) => task.id));
	let removed = 0;
	try {
		const existing = await queue.getJobSchedulers();
		for (const scheduler of existing) {
		const id = scheduler.key;
		if (wanted.has(id)) {
			continue;
		}
		await queue.removeJobScheduler(id);
		removed += 1;
		log('stale schedule removed', { queue: queue.name, id });
		}
	} catch (error) {
		throw new CronSchedulerError(
			`failed to reconcile stale schedules on queue "${queue.name}": ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	log('schedule sync complete', {
		queue: queue.name,
		upserted: affected,
		staleRemoved: removed,
	});
}
