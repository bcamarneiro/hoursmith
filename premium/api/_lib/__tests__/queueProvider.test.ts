/**
 * Tests for the BullMQ queue provider (ADA-695).
 *
 * `bullmq` is mocked at the module boundary so the tests exercise the wiring
 * (names, shared options, singleton behavior) without a live Redis.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
	Queue: vi.fn(),
}));

import { Queue } from 'bullmq';

import {
	closeQueue,
	createQueue,
	getRawCommitsQueue,
	QUEUE_NAMES,
	queueOptions,
} from '../queueProvider.js';

const MockQueue = vi.mocked(Queue);

beforeEach(() => {
	MockQueue.mockReset();
	MockQueue.mockImplementation(
		(name: string, opts: unknown) =>
			({
				name,
				opts,
				close: vi.fn().mockResolvedValue(undefined),
			}) as unknown as Queue,
	);
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe('QUEUE_NAMES', () => {
	it('exposes the raw-commits queue name', () => {
		expect(QUEUE_NAMES.RAW_COMMITS).toBe('raw-commits');
	});
});

describe('queueOptions', () => {
	it('resolves the Redis connection from env', () => {
		const opts = queueOptions({ REDIS_URL: 'redis://cache:6379/1' });
		expect(opts.connection).toMatchObject({
			host: 'cache',
			db: 1,
			maxRetriesPerRequest: null,
		});
	});

	it('defaults job options to bounded retention and retries', () => {
		const opts = queueOptions({ REDIS_URL: 'redis://cache' });
		expect(opts.defaultJobOptions?.attempts).toBe(3);
		expect(opts.defaultJobOptions?.backoff).toEqual({
			type: 'exponential',
			delay: 5_000,
		});
		expect(opts.defaultJobOptions?.removeOnComplete).toMatchObject({
			age: 3_600,
			count: 1_000,
		});
		expect(opts.defaultJobOptions?.removeOnFail).toMatchObject({
			age: 86_400,
			count: 1_000,
		});
	});

	it('applies QUEUE_JOB_* env overrides to job options', () => {
		const opts = queueOptions({
			REDIS_URL: 'redis://cache',
			QUEUE_JOB_ATTEMPTS: '6',
			QUEUE_JOB_BACKOFF_TYPE: 'fixed',
			QUEUE_JOB_BACKOFF_DELAY_MS: '250',
			QUEUE_JOB_REMOVE_ON_COMPLETE_AGE_S: '30',
		});
		expect(opts.defaultJobOptions?.attempts).toBe(6);
		expect(opts.defaultJobOptions?.backoff).toEqual({
			type: 'fixed',
			delay: 250,
		});
		expect(opts.defaultJobOptions?.removeOnComplete).toMatchObject({
			age: 30,
			count: 1_000,
		});
	});
});

describe('createQueue', () => {
	it('constructs a BullMQ queue with the shared options', () => {
		const queue = createQueue('my-queue', {
			env: { REDIS_URL: 'redis://cache' },
		});
		expect(MockQueue).toHaveBeenCalledTimes(1);
		expect(MockQueue).toHaveBeenCalledWith(
			'my-queue',
			expect.objectContaining({
				connection: expect.objectContaining({ maxRetriesPerRequest: null }),
			}),
		);
		expect(queue.name).toBe('my-queue');
	});
});

describe('getRawCommitsQueue', () => {
	it('returns a singleton queue named raw-commits', () => {
		vi.stubEnv('REDIS_URL', 'redis://cache');
		MockQueue.mockClear();

		const first = getRawCommitsQueue();
		const second = getRawCommitsQueue();

		expect(first).toBe(second);
		expect(first.name).toBe('raw-commits');
		expect(MockQueue).toHaveBeenCalledTimes(1);
	});
});

describe('closeQueue', () => {
	it('closes the queue and tolerates repeated calls', async () => {
		const queue = createQueue('x', { env: { REDIS_URL: 'redis://cache' } });
		await closeQueue(queue);
		await closeQueue(queue);
		expect(queue.close).toHaveBeenCalledTimes(2);
	});
});
