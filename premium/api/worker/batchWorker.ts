/**
 * Generic batch worker (ADA-710).
 *
 * Drains a BullMQ queue in batches: pull up to `batchSize` waiting jobs,
 * process their payloads through a caller-supplied `processor` (no business
 * logic lives here), settle the batch (completed/failed), then poll again.
 * When the queue is empty the worker idles for `pollIntervalMs` before the
 * next poll, so an empty queue does not thrash Redis.
 *
 * Connection policy: this is a single-process batch drainer. If Redis is
 * unreachable (startup or mid-flight) queue operations throw; the poll loop
 * catches those failures and backs off with an exponential policy instead of
 * crashing, retrying until the connection comes back or `stop()` is called.
 * Job-level retries are not handled here — they are expressed as BullMQ job
 * options (`attempts` + `backoff` on the queue, see `queueProvider.queueOptions`).
 *
 * Semantics are at-least-once: a job is only removed from the queue after
 * `moveToCompleted` succeeds, so a crash mid-batch re-queues the unprocessed
 * remainder. The worker is designed to run as a single instance; concurrent
 * instances must be coordinated at the queue level (e.g. BullMQ's own
 * `Worker` class with per-job locking).
 */

import { randomUUID } from 'node:crypto';

import type { Job, Queue } from 'bullmq';

import { type BackoffOptions, backoffDelay, sleep } from './backoff.js';

export interface BatchWorkerOptions<Payload, Result> {
	/** BullMQ queue to drain. */
	queue: Queue<Payload>;
	/** Pure payload → result. A rejection marks the job failed (retried per job options). */
	processor: (payload: Payload) => Promise<Result>;
	/** Maximum jobs pulled per batch (default 10). */
	batchSize?: number;
	/** Maximum payloads processed concurrently inside a batch (defaults to `batchSize`). */
	concurrency?: number;
	/** Idle delay between batches when the queue is empty, in ms (default 5_000). */
	pollIntervalMs?: number;
	/** Connection retry policy for Redis outages (defaults: 1s base, 30s cap, ×2). */
	connectionBackoff?: BackoffOptions;
	/** Called after each batch settles with its result counts. */
	onBatchComplete?: (batch: BatchResult<Result>) => void | Promise<void>;
	/** Log sink; defaults to `console.log`. */
	log?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface BatchResult<Result> {
	batchSize: number;
	succeeded: number;
	failed: number;
	results: Result[];
	errors: Array<{ jobId: string; error: Error }>;
	elapsedMs: number;
}

export interface BatchWorker {
	/** Begin draining. Resolves when the first poll completes or `stop()` is called. */
	start(): Promise<void>;
	/** Stop draining after the in-flight batch settles. Safe to call repeatedly. */
	stop(): Promise<void>;
	/** True while the drain loop is running. */
	isRunning(): boolean;
}

const DEFAULT_BACKOFF: BackoffOptions = {
	initialDelayMs: 1_000,
	maxDelayMs: 30_000,
	factor: 2,
	jitter: true,
};

export function createBatchWorker<Payload, Result = void>(
	options: BatchWorkerOptions<Payload, Result>,
): BatchWorker {
	const {
		queue,
		processor,
		batchSize = 10,
		concurrency = batchSize,
		pollIntervalMs = 5_000,
		connectionBackoff = DEFAULT_BACKOFF,
		onBatchComplete,
		log = defaultLog,
	} = options;

	// Token identifies this worker instance when settling jobs, matching how
	// BullMQ workers sign `moveToCompleted`/`moveToFailed` calls.
	const token = randomUUID();
	let running = false;
	let stopped = false;

	async function fetchBatch(): Promise<Array<Job<Payload>>> {
		return queue.getWaiting(0, batchSize);
	}

	async function settleBatch(
		batch: Array<Job<Payload>>,
		perJob: Map<string, { result?: Result; error?: Error }>,
	): Promise<void> {
		await Promise.all(
			batch.map(async (job) => {
				const jobId = job.id as string;
				const entry = perJob.get(jobId);
				if (entry?.error) {
					await job.moveToFailed(entry.error, token);
				} else {
					await job.moveToCompleted(entry?.result, token);
				}
			}),
		);
	}

	async function drainOnce(batch: Array<Job<Payload>>): Promise<BatchResult<Result>> {
		const startedAt = Date.now();
		const perJob = new Map<string, { result?: Result; error?: Error }>();
		const errors: Array<{ jobId: string; error: Error }> = [];
		let cursor = 0;

		const processNext = (): Promise<void> => {
			if (cursor >= batch.length) {
				return Promise.resolve();
			}
			const job = batch[cursor];
			const jobId = job.id as string;
			cursor += 1;
			// Each chain keeps pulling the next job until the batch is
			// exhausted, so at most `concurrency` payloads run at once.
			return processor(job.data)
				.then((result) => {
					perJob.set(jobId, { result });
				})
				.catch((error: unknown) => {
					const err = toError(error);
					perJob.set(jobId, { error: err });
					errors.push({ jobId, error: err });
				})
				.then(() => processNext());
		};

		// Bounded concurrency: each worker chain pulls the next job until the
		// batch is exhausted, so at most `concurrency` payloads run at once.
		const chains = Array.from(
			{ length: Math.min(concurrency, batch.length) },
			() => processNext(),
		);
		await Promise.all(chains);

		await settleBatch(batch, perJob);

		const results: Result[] = [];
		for (const entry of perJob.values()) {
			if (entry.result !== undefined) {
				results.push(entry.result);
			}
		}

		return {
			batchSize: batch.length,
			succeeded: results.length,
			failed: errors.length,
			results,
			errors,
			elapsedMs: Date.now() - startedAt,
		};
	}

	async function run(): Promise<void> {
		running = true;
		let connectionAttempt = 0;
		while (!stopped) {
			try {
				const batch = await fetchBatch();
				if (batch.length === 0) {
					connectionAttempt = 0;
					if (stopped) {
						break;
					}
					await sleep(pollIntervalMs);
					continue;
				}
				const outcome = await drainOnce(batch);
				connectionAttempt = 0;
				log('batch settled', {
					batchSize: outcome.batchSize,
					succeeded: outcome.succeeded,
					failed: outcome.failed,
					elapsedMs: outcome.elapsedMs,
				});
				if (onBatchComplete) {
					await onBatchComplete(outcome);
				}
			} catch (error) {
				const delay = backoffDelay(connectionAttempt + 1, connectionBackoff);
				connectionAttempt += 1;
				log('worker poll failed; backing off before retry', {
					error: toError(error).message,
					delayMs: delay,
					attempt: connectionAttempt,
				});
				await sleep(delay);
			}
		}
		running = false;
	}

	let runPromise: Promise<void> | null = null;
	return {
		start() {
			if (!runPromise) {
				runPromise = run();
			}
			return runPromise;
		},
		async stop() {
			stopped = true;
			await runPromise;
		},
		isRunning() {
			return running;
		},
	};
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function defaultLog(message: string, extra?: Record<string, unknown>): void {
	const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
	console.log(`[worker] ${message}${suffix}`);
}
