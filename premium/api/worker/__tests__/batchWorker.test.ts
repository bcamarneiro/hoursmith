/**
 * Tests for the generic batch worker loop (ADA-710).
 *
 * BullMQ is not touched here: the worker is exercised against a fake queue
 * that implements exactly the surface the worker uses (`getWaiting` +
 * per-job `moveToCompleted`/`moveToFailed`), so the loop semantics
 * (batch drain, at-least-once settle, idle polling, connection backoff,
 * stop) are tested without Redis.
 *
 * Real (small) timers + `vi.waitFor` are used instead of fake timers —
 * the drain loop's internal microtask chains are easier to drive
 * deterministically that way.
 */

import type { Job, Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBatchWorker } from '../batchWorker.js';
import type { BackoffOptions } from '../backoff.js';

interface Payload {
	n: number;
}

type QueueMock = Queue<Payload> & { getWaiting: ReturnType<typeof vi.fn> };

function fakeJob(id: string, data: Payload = { n: 0 }): Job<Payload> {
	return {
		id,
		data,
		moveToCompleted: vi.fn().mockResolvedValue(undefined),
		moveToFailed: vi.fn().mockResolvedValue(undefined),
	} as unknown as Job<Payload>;
}

function makeQueue(sequence: Array<Array<Job<Payload>>>): {
	queue: Queue<Payload>;
	getWaiting: ReturnType<typeof vi.fn>;
} {
	const calls = [...sequence];
	const getWaiting = vi
		.fn()
		.mockImplementation(async () => (calls.length > 0 ? calls.shift() : []));
	return { queue: { getWaiting } as unknown as QueueMock, getWaiting };
}

const BACKOFF: BackoffOptions = {
	initialDelayMs: 5,
	maxDelayMs: 100,
	factor: 2,
	jitter: false,
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('createBatchWorker', () => {
	it('drains a batch through the processor and settles every job', async () => {
		const jobs = [fakeJob('1', { n: 1 }), fakeJob('2', { n: 2 })];
		const { queue } = makeQueue([jobs]);
		const processor = vi
			.fn()
			.mockImplementation(async (payload: Payload) => payload.n * 10);
		const onBatchComplete = vi.fn();

		const worker = createBatchWorker({
			queue,
			processor,
			batchSize: 10,
			pollIntervalMs: 50,
			onBatchComplete,
		});
		const startPromise = worker.start();

		await vi.waitFor(() => {
			expect(processor).toHaveBeenCalledTimes(2);
			expect(jobs[0].moveToCompleted).toHaveBeenCalledWith(
				10,
				expect.any(String),
			);
			expect(jobs[1].moveToCompleted).toHaveBeenCalledWith(
				20,
				expect.any(String),
			);
			expect(jobs[0].moveToFailed).not.toHaveBeenCalled();
		});
		expect(onBatchComplete).toHaveBeenCalledWith(
			expect.objectContaining({ batchSize: 2, succeeded: 2, failed: 0 }),
		);

		await worker.stop();
		await startPromise;
	});

	it('marks failed jobs with moveToFailed and keeps successes completed', async () => {
		const good = fakeJob('1', { n: 1 });
		const bad = fakeJob('2', { n: 2 });
		const { queue } = makeQueue([[good, bad]]);
		const processor = vi.fn().mockImplementation(async (payload: Payload) => {
			if (payload.n === 2) {
				throw new Error('boom');
			}
			return 'ok';
		});
		const onBatchComplete = vi.fn();

		const worker = createBatchWorker({
			queue,
			processor,
			batchSize: 10,
			pollIntervalMs: 50,
			onBatchComplete,
		});
		const startPromise = worker.start();

		await vi.waitFor(() => {
			expect(good.moveToCompleted).toHaveBeenCalledWith(
				'ok',
				expect.any(String),
			);
			expect(bad.moveToFailed).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'boom' }),
				expect.any(String),
			);
			expect(bad.moveToCompleted).not.toHaveBeenCalled();
		});
		expect(onBatchComplete).toHaveBeenCalledWith(
			expect.objectContaining({ batchSize: 2, succeeded: 1, failed: 1 }),
		);

		await worker.stop();
		await startPromise;
	});

	it('limits in-batch concurrency', async () => {
		const jobs = Array.from({ length: 4 }, (_, i) => fakeJob(String(i + 1)));
		const { queue } = makeQueue([jobs]);
		let inFlight = 0;
		let peak = 0;
		const processor = vi.fn().mockImplementation(async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 10));
			inFlight -= 1;
			return 'ok';
		});

		const worker = createBatchWorker({
			queue,
			processor,
			batchSize: 4,
			concurrency: 2,
			pollIntervalMs: 50,
		});
		const startPromise = worker.start();

		await vi.waitFor(() => {
			expect(processor).toHaveBeenCalledTimes(4);
			expect(peak).toBe(2);
		});

		await worker.stop();
		await startPromise;
	});

	it('idles on an empty queue without hammering getWaiting', async () => {
		vi.useFakeTimers();
		const { queue, getWaiting } = makeQueue([]);
		const worker = createBatchWorker({
			queue,
			processor: vi.fn().mockResolvedValue('ok'),
			pollIntervalMs: 5_000,
		});
		const startPromise = worker.start();
		await vi.advanceTimersByTimeAsync(10_000);

		// One poll for the initial check, one after each idle interval.
		expect(getWaiting).toHaveBeenCalledTimes(3);

		worker.stop();
		await vi.advanceTimersByTimeAsync(5_000);
		await startPromise;
	});

	it('backs off with the connection policy when Redis is unreachable, then recovers', async () => {
		const getWaiting = vi
			.fn()
			.mockRejectedValueOnce(new Error('ECONNREFUSED'))
			.mockResolvedValue([]);
		const queue = { getWaiting } as unknown as QueueMock;
		const log = vi.fn();

		const worker = createBatchWorker({
			queue,
			processor: vi.fn().mockResolvedValue('ok'),
			connectionBackoff: BACKOFF,
			pollIntervalMs: 50,
			log,
		});
		const startPromise = worker.start();

		await vi.waitFor(() => {
			// First poll failed → backoff sleep → poll again (and keep polling).
			expect(getWaiting.mock.calls.length).toBeGreaterThanOrEqual(2);
		});
		expect(log).toHaveBeenCalledWith(
			'worker poll failed; backing off before retry',
			expect.objectContaining({
				error: 'ECONNREFUSED',
				delayMs: 10,
				attempt: 1,
			}),
		);

		await worker.stop();
		await startPromise;
	});

	it('stop() ends the loop and is idempotent', async () => {
		const { queue } = makeQueue([]);
		const worker = createBatchWorker({
			queue,
			processor: vi.fn().mockResolvedValue('ok'),
			pollIntervalMs: 50,
		});
		const startPromise = worker.start();

		const stopPromise = worker.stop();
		const stopPromise2 = worker.stop();
		await Promise.all([startPromise, stopPromise, stopPromise2]);
		expect(worker.isRunning()).toBe(false);
	});
});
