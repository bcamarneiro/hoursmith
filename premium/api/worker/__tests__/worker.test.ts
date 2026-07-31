/**
 * Tests for the background worker factory (ADA-696).
 *
 * `bullmq` is mocked at the module boundary so the tests exercise the wiring
 * (name, connection, concurrency, event handlers, close) without a live Redis.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
	Worker: vi.fn(),
}));

import { Worker } from 'bullmq';

import {
	createWorker,
	WorkerConfigError,
	type WorkerLogFn,
} from '../worker.js';

const MockWorker = vi.mocked(Worker);

interface FakeWorker {
	name: string;
	opts: unknown;
	listeners: Record<string, (...args: unknown[]) => void>;
	close: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
}

function mockWorkerInstance(
	name: string,
	_processor: unknown,
	opts: unknown,
): FakeWorker {
	const instance: FakeWorker = {
		name,
		opts,
		listeners: {},
		close: vi.fn().mockResolvedValue(undefined),
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			instance.listeners[event] = handler;
		}),
	};
	return instance;
}

let instances: FakeWorker[] = [];

beforeEach(() => {
	instances = [];
	MockWorker.mockReset();
	MockWorker.mockImplementation(
		(name: string, processor: unknown, opts: unknown) => {
			const instance = mockWorkerInstance(name, processor, opts);
			instances.push(instance);
			return instance as unknown as Worker;
		},
	);
});

function workerInstance(): FakeWorker {
	const instance = instances[0];
	if (!instance) {
		throw new Error('no worker instance was created');
	}
	return instance;
}

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

const processor = vi.fn(async () => ({ ok: true }));

describe('createWorker', () => {
	it('constructs a BullMQ worker with the resolved Redis connection', () => {
		const handle = createWorker({
			queueName: 'raw-commits',
			processor,
			env: { REDIS_URL: 'redis://cache:6379/2' },
		});

		expect(MockWorker).toHaveBeenCalledTimes(1);
		expect(MockWorker).toHaveBeenCalledWith(
			'raw-commits',
			processor,
			expect.objectContaining({
				connection: expect.objectContaining({
					host: 'cache',
					db: 2,
					maxRetriesPerRequest: null,
				}),
			}),
		);
		expect(handle.queueName).toBe('raw-commits');
	});

	it('defaults to one concurrent job', () => {
		createWorker({ queueName: 'q', processor, env: { REDIS_URL: 'redis://cache' } });
		expect(MockWorker).toHaveBeenCalledWith(
			'q',
			processor,
			expect.objectContaining({ concurrency: 1 }),
		);
	});

	it('passes through a custom concurrency', () => {
		createWorker({
			queueName: 'q',
			processor,
			concurrency: 4,
			env: { REDIS_URL: 'redis://cache' },
		});
		expect(MockWorker).toHaveBeenCalledWith(
			'q',
			processor,
			expect.objectContaining({ concurrency: 4 }),
		);
	});

	it('rejects a non-positive concurrency', () => {
		expect(() =>
			createWorker({
				queueName: 'q',
				processor,
				concurrency: 0,
				env: { REDIS_URL: 'redis://cache' },
			}),
		).toThrow(WorkerConfigError);
		expect(MockWorker).not.toHaveBeenCalled();
	});

	it('throws when Redis config is missing', () => {
		expect(() => createWorker({ queueName: 'q', processor, env: {} })).toThrow(
			/Missing Redis configuration/,
		);
		expect(MockWorker).not.toHaveBeenCalled();
	});

	it('logs job failures with job metadata', () => {
		const log = vi.fn() as unknown as WorkerLogFn;
		createWorker({
			queueName: 'raw-commits',
			processor,
			env: { REDIS_URL: 'redis://cache' },
			log,
		});

		const failed = workerInstance().listeners.failed;
		expect(failed).toBeTypeOf('function');
		failed({ id: 'job-1', attemptsMade: 2 }, new Error('boom'));

		expect(log).toHaveBeenCalledWith('job failed', {
			queue: 'raw-commits',
			jobId: 'job-1',
			attempt: 2,
			error: 'boom',
		});
	});

	it('logs worker (connection) errors', () => {
		const log = vi.fn() as unknown as WorkerLogFn;
		createWorker({
			queueName: 'raw-commits',
			processor,
			env: { REDIS_URL: 'redis://cache' },
			log,
		});

		const error = workerInstance().listeners.error;
		expect(error).toBeTypeOf('function');
		error(new Error('ECONNREFUSED'));

		expect(log).toHaveBeenCalledWith('worker error', {
			queue: 'raw-commits',
			error: 'ECONNREFUSED',
		});
	});

	it('close() drains the underlying worker', async () => {
		const handle = createWorker({
			queueName: 'q',
			processor,
			env: { REDIS_URL: 'redis://cache' },
		});

		await handle.close();
		await handle.close();
		expect(workerInstance().close).toHaveBeenCalledTimes(2);
	});
});
