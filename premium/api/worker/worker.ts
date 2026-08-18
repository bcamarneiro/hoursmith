/**
 * Background worker initialization for premium queues (ADA-696).
 *
 * Builds a BullMQ `Worker` (real-time queue listener) for a named queue using
 * the shared Redis config from `redisConfig.js`, so producers (queueProvider)
 * and consumers agree on the connection and job options. The worker starts
 * listening as soon as it is constructed; `close()` drains running jobs and
 * releases the Redis connection — pair it with `registerGracefulShutdown` from
 * `gracefulShutdown.js` for SIGTERM/SIGINT handling.
 *
 * Job-level retries come from the queue's default job options (`attempts` +
 * exponential `backoff`); the worker only observes and logs outcomes.
 */

import { Worker, type Processor } from 'bullmq';

import { type RedisEnv, redisOptions } from '../_lib/redisConfig.js';

/** Log sink for worker lifecycle events. Mirrors the batch worker's log fn. */
export type WorkerLogFn = (
	message: string,
	extra?: Record<string, unknown>,
) => void;

/** Default log: `[worker]` prefix plus an optional JSON payload. */
export const defaultWorkerLog: WorkerLogFn = (message, extra) => {
	const suffix =
		extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
	console.log(`[worker] ${message}${suffix}`);
};

export class WorkerConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkerConfigError';
	}
}

export interface WorkerInitOptions<Payload, Result> {
	/** Queue name — must match the producer's queue (see `QUEUE_NAMES`). */
	queueName: string;
	/** BullMQ processor: `(job) => Promise<result>`; called per job. */
	processor: Processor<Payload, Result>;
	/** Jobs processed concurrently by this worker (default 1). */
	concurrency?: number;
	/** Env to resolve the Redis connection from; defaults to `process.env`. Tests inject here. */
	env?: RedisEnv;
	/** Log sink for job failures and worker errors (default `defaultWorkerLog`). */
	log?: WorkerLogFn;
}

export interface WorkerHandle<Payload, Result> {
	/** Queue this worker listens on. */
	queueName: string;
	/** The underlying BullMQ worker (already listening). */
	worker: Worker<Payload, Result>;
	/**
	 * Gracefully stop: stop accepting new jobs, wait for active jobs to
	 * finish, then release the Redis connection. Safe to call repeatedly.
	 */
	close(): Promise<void>;
}

/**
 * Create and start a BullMQ worker for `queueName`.
 *
 * Throws `WorkerConfigError` on invalid options (e.g. `concurrency < 1`).
 * Redis misconfiguration is deliberately loud: `redisOptions` throws when no
 * `REDIS_URL`/`REDIS_HOST` is present instead of churning against nothing.
 */
export function createWorker<Payload, Result>(
	options: WorkerInitOptions<Payload, Result>,
): WorkerHandle<Payload, Result> {
	const {
		queueName,
		processor,
		concurrency = 1,
		env = process.env,
		log = defaultWorkerLog,
	} = options;

	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new WorkerConfigError(
			`concurrency must be a positive integer, got "${concurrency}".`,
		);
	}

	const worker = new Worker<Payload, Result>(queueName, processor, {
		connection: redisOptions(env),
		concurrency,
	});

	worker.on('failed', (job, error) => {
		log(`job failed`, {
			queue: queueName,
			jobId: job?.id,
			attempt: job?.attemptsMade,
			error: error.message,
		});
	});

	worker.on('error', (error) => {
		// Redis connection problems surface here; BullMQ keeps retrying, but
		// an operator must see the cause in the logs.
		log(`worker error`, { queue: queueName, error: error.message });
	});

	return {
		queueName,
		worker,
		close: async () => {
			await worker.close();
		},
	};
}
