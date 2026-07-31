#!/usr/bin/env node
/**
 * CLI entrypoint for the premium cron scheduler (ADA-697).
 *
 * Syncs the CRON_TASKS registry (see `cron.ts`) into BullMQ Job Schedulers
 * on the queues the batch worker drains:
 *
 *   tsx premium/api/worker/schedulerCli.ts
 *   tsx premium/api/worker/schedulerCli.ts --queue raw-commits
 *
 * Safe to run repeatedly (idempotent upsert + stale-schedule pruning) — call
 * it at deploy time or from a slow cron so schedule changes take effect.
 * Requires REDIS_URL/REDIS_HOST to be configured (see redisConfig.ts).
 *
 * Exit codes: 0 on success, 1 on usage or sync errors.
 */

import { closeQueue, createQueue } from '../_lib/queueProvider.js';
import { CRON_TASKS, validateCronTasks } from './cron.js';
import { CronSchedulerError, syncCronTasks } from './scheduler.js';

const USAGE = `Usage:
  tsx premium/api/worker/schedulerCli.ts [options]

Options:
  --queue <name>   Only sync schedules for this queue (default: all queues in CRON_TASKS).
  --help           Show this help and exit.`;

interface CliOptions {
	queueFilter?: string;
	help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = (): string => {
			const next = argv[i + 1];
			if (next === undefined) {
				console.error(`[scheduler] --${flag} requires a value.`);
				process.exit(1);
			}
			i += 1;
			return next;
		};
		switch (flag) {
			case '--help':
			case '-h':
				options.help = true;
				break;
			case '--queue':
				options.queueFilter = value();
				break;
			default:
				console.error(`[scheduler] unknown flag "${flag}".`);
				console.error(USAGE);
				process.exit(1);
		}
	}
	return options;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return;
	}

	const registryProblems = validateCronTasks(CRON_TASKS);
	if (registryProblems.length > 0) {
		throw new CronSchedulerError(
			`Invalid CRON_TASKS registry: ${registryProblems.join('; ')}`,
		);
	}

	const queueNames = [...new Set(CRON_TASKS.map((task) => task.queue))].filter(
		(name) => !options.queueFilter || name === options.queueFilter,
	);

	if (queueNames.length === 0) {
		throw new CronSchedulerError(
			`No scheduled tasks for queue "${options.queueFilter}".`,
		);
	}

	for (const queueName of queueNames) {
		const tasks = CRON_TASKS.filter((task) => task.queue === queueName);
		const queue = createQueue(queueName);
		try {
			await syncCronTasks(queue, tasks);
		} finally {
			await closeQueue(queue);
		}
	}
}

main().catch((error: unknown) => {
	console.error(
		'[scheduler] fatal:',
		error instanceof Error ? error.message : String(error),
	);
	process.exit(1);
});
