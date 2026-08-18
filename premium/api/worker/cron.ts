/**
 * Cron scheduling definitions for premium background jobs (ADA-697).
 *
 * Scheduled execution is layered on BullMQ's Job Scheduler API: each
 * `CronTask` maps to one JobScheduler on a queue, so the cron engine is the
 * same cron-parser that BullMQ ships (no separate scheduler process, no
 * clock drift, and schedules survive worker restarts because they live in
 * Redis). The batch worker (see `worker/cli.ts`) then picks the resulting
 * jobs up from the queue like any other.
 *
 * This module owns the *definitions* — the list of schedules the product
 * runs. `worker/scheduler.ts` owns the mechanics of syncing those
 * definitions into Redis.
 */

import { QUEUE_NAMES } from '../_lib/queueProvider.js';

/**
 * A cron pattern in standard 5-field form (minute hour day-of-month month
 * day-of-week) or 6-field form with a leading seconds field. Parsed by
 * cron-parser (BullMQ's bundled cron engine) when the scheduler is synced.
 */
export type CronPattern = string;

/** One scheduled task: a job that is enqueued on a queue at cron intervals. */
export interface CronTask {
	/**
	 * Stable identifier. Doubles as the BullMQ JobScheduler id, so renaming a
	 * task is a destructive operation (the old scheduler must be removed).
	 */
	id: string;
	/** Queue the scheduled job is enqueued on (see `QUEUE_NAMES`). */
	queue: string;
	/** Cron pattern controlling when the job fires. */
	pattern: CronPattern;
	/** IANA timezone the pattern is evaluated in (default UTC). */
	timezone?: string;
	/**
	 * Job name stored on the scheduled job. The worker's processor receives
	 * `job.data`; a no-payload `reconcile` trigger tells the processor to
	 * look for pending work (e.g. raw commits that missed the webhook path).
	 */
	jobName?: string;
	/** Payload attached to every scheduled job (default `{}`). */
	data?: unknown;
	/** Human-readable purpose; surfaced in the scheduler CLI's `--list`. */
	description?: string;
}

/**
 * The schedules the product runs. Add new scheduled work here; the
 * scheduler CLI (`worker/schedulerCli.ts`) syncs the whole registry.
 *
 * Default: a reconciliation trigger on the raw-commits queue every 5
 * minutes, so commit ingestion is periodically re-checked even if webhook
 * delivery stalled or a batch failed partway.
 */
export const CRON_TASKS: readonly CronTask[] = [
	{
		id: 'raw-commits-reconcile',
		queue: QUEUE_NAMES.RAW_COMMITS,
		pattern: '*/5 * * * *',
		timezone: 'UTC',
		jobName: 'reconcile',
		data: {},
		description:
			'Periodically trigger raw-commit reconciliation for commits that missed webhook ingestion.',
	},
];

/**
 * Structural validation for a cron pattern. Catches obvious config errors
 * (empty, wrong field count, illegal characters); authoritative parsing
 * happens in cron-parser when BullMQ upserts the scheduler.
 */
export function validateCronPattern(pattern: string): string[] {
	const problems: string[] = [];
	if (pattern.trim() === '') {
		problems.push('pattern must be a non-empty cron expression');
		return problems;
	}
	const fields = pattern.trim().split(/\s+/);
	if (fields.length !== 5 && fields.length !== 6) {
		problems.push(
			`pattern must have 5 or 6 fields (got ${fields.length}): "${pattern}"`,
		);
	}
	for (const field of fields) {
		if (!/^[0-9A-Za-z*,/#?L\-W]+$/.test(field)) {
			problems.push(`field "${field}" contains illegal characters`);
		}
	}
	return problems;
}

function validateTimezone(timezone: string): string[] {
	try {
		// Throws RangeError on unknown IANA timezones.
		new Intl.DateTimeFormat('en-US', { timeZone: timezone });
		return [];
	} catch {
		return [`unknown IANA timezone "${timezone}"`];
	}
}

/**
 * Validate a task registry. Returns a list of problems (empty when valid):
 * duplicate ids, empty queue names, malformed patterns, unknown timezones.
 */
export function validateCronTasks(tasks: readonly CronTask[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const task of tasks) {
		if (task.id.trim() === '') {
			problems.push('task id must be a non-empty string');
		} else if (seen.has(task.id)) {
			problems.push(`duplicate task id "${task.id}"`);
		}
		seen.add(task.id);
		if (task.queue.trim() === '') {
			problems.push(`task "${task.id}": queue must be a non-empty string`);
		}
		problems.push(
			...validateCronPattern(task.pattern).map(
				(problem) => `task "${task.id}": ${problem}`,
			),
		);
		if (task.timezone !== undefined) {
			problems.push(
				...validateTimezone(task.timezone).map(
					(problem) => `task "${task.id}": ${problem}`,
				),
			);
		}
	}
	return problems;
}

/**
 * Validate the built-in registry at module load, so a bad schedule fails the
 * deploy loudly instead of silently never firing.
 */
const registryProblems = validateCronTasks(CRON_TASKS);
if (registryProblems.length > 0) {
	throw new Error(
		`Invalid CRON_TASKS registry: ${registryProblems.join('; ')}`,
	);
}
