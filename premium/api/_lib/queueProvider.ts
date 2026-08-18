/**
 * BullMQ queue provider (ADA-695).
 *
 * Central place for queue names and queue construction so producers and
 * consumers agree on names, the Redis connection, and default job options.
 * The connection is resolved from env via `queueConnection.js`; nothing here
 * touches the network until a producer actually adds a job.
 */

import { Queue, type QueueOptions } from 'bullmq';

import { parseQueueSettings } from './queueConfig.js';
import { loadQueueConnectionConfig } from './queueConnection.js';
import type { RedisEnv } from './redisConfig.js';

/** Queue names shared by producers and consumers. */
export const QUEUE_NAMES = {
	/** GitLab webhook ingestion queue (ADA-631); jobs reference `raw_commits` rows. */
	RAW_COMMITS: 'raw-commits',
} as const;

/** Payload of a `raw-commits` job: which `raw_commits` row to process. */
export interface RawCommitJob {
	rawCommitId: number;
	projectId: number;
	userUsername: string;
	ref: string;
}

export type { RedisEnv };

export interface QueueFactoryOptions {
	/** Env to resolve the Redis connection from; defaults to `process.env`. Tests inject here. */
	env?: RedisEnv;
}

/**
 * BullMQ options shared by every premium queue (bounded retention + retries).
 * The job settings resolve from `QUEUE_JOB_*` env vars via `parseQueueSettings`,
 * so operators can tune retry/retention without a code deploy.
 */
export function queueOptions(env: RedisEnv = process.env): QueueOptions {
	const settings = parseQueueSettings(env);
	return {
		connection: loadQueueConnectionConfig(env).options,
		defaultJobOptions: {
			// Webhook ingestion sees transient failures; retry before giving up.
			attempts: settings.attempts,
			backoff: {
				type: settings.backoffType,
				delay: settings.backoffDelayMs,
			},
			// Keep Redis memory bounded: drop finished jobs after 1h, failures after 1d.
			removeOnComplete: {
				age: settings.removeOnCompleteAgeS,
				count: settings.removeOnCompleteCount,
			},
			removeOnFail: {
				age: settings.removeOnFailAgeS,
				count: settings.removeOnFailCount,
			},
		},
	};
}

/** Build a BullMQ `Queue` with the shared options. */
export function createQueue<Payload = unknown>(
	name: string,
	{ env }: QueueFactoryOptions = {},
): Queue<Payload> {
	return new Queue<Payload>(name, queueOptions(env));
}

let rawCommitsQueue: Queue<RawCommitJob> | null = null;

/**
 * Process-wide singleton for the `raw-commits` queue. Lazily created on first
 * use so serverless endpoints that never enqueue don't pay connection setup.
 */
export function getRawCommitsQueue(): Queue<RawCommitJob> {
	if (!rawCommitsQueue) {
		rawCommitsQueue = createQueue<RawCommitJob>(QUEUE_NAMES.RAW_COMMITS);
	}
	return rawCommitsQueue;
}

/** Gracefully close a queue's Redis connection. Safe to call repeatedly. */
export async function closeQueue(queue: Queue): Promise<void> {
	if (queue && typeof queue.close === 'function') {
		await queue.close();
	}
}
