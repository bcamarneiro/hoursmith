/**
 * Tests for the base worker (ADA-699).
 *
 * `bullmq` is mocked at the module boundary so the tests exercise lifecycle,
 * error logging, and graceful shutdown wiring without a live Redis.
 */

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
	Worker: vi.fn(),
}));

import { Worker } from 'bullmq';

import { BaseWorker } from '../baseWorker.js';

const MockWorker = vi.mocked(Worker);

class FakeWorker extends EventEmitter {
	readonly close = vi.fn().mockResolvedValue(undefined);
	readonly waitUntilReady = vi.fn(() =>
		readyError ? Promise.reject(readyError) : Promise.resolve(undefined),
	);

	name = '';
	processor: unknown;
	opts: unknown;
}

let instances: FakeWorker[] = [];
let readyError: Error | null = null;

function makeLogger() {
	const error = vi.fn();
	const info = vi.fn();
	return { error, info, logger: { error, info } };
}

const noopProcessor = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
	instances = [];
	readyError = null;
	MockWorker.mockReset();
	MockWorker.mockImplementation(
		(name: string, processor: unknown, opts: unknown) => {
			const instance = new FakeWorker();
			instance.name = name;
			instance.processor = processor;
			instance.opts = opts;
			instances.push(instance);
			return instance as unknown as Worker;
		},
	);
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('BaseWorker', () => {
	it('exposes the queue name', () => {
		const worker = new BaseWorker('raw-commits', noopProcessor);
		expect(worker.queueName).toBe('raw-commits');
	});

	it('is not running before start', () => {
		const worker = new BaseWorker('raw-commits', noopProcessor);
		expect(worker.isRunning).toBe(false);
	});

	it('starts a BullMQ worker with the shared Redis connection', async () => {
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache:6379/2' },
		});

		await worker.start();

		expect(MockWorker).toHaveBeenCalledTimes(1);
		expect(MockWorker).toHaveBeenCalledWith(
			'raw-commits',
			noopProcessor,
			expect.objectContaining({
				connection: expect.objectContaining({
					host: 'cache',
					port: 6379,
					db: 2,
					maxRetriesPerRequest: null,
				}),
			}),
		);
		expect(worker.isRunning).toBe(true);
		expect(instances[0].waitUntilReady).toHaveBeenCalledTimes(1);

		await worker.stop();
	});

	it('passes through extra BullMQ worker options', async () => {
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
			workerOptions: { concurrency: 3 },
		});

		await worker.start();

		expect(instances[0].opts).toMatchObject({ concurrency: 3 });

		await worker.stop();
	});

	it('is idempotent under repeated start calls', async () => {
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
		});

		await worker.start();
		await worker.start();
		await worker.start();

		expect(MockWorker).toHaveBeenCalledTimes(1);

		await worker.stop();
	});

	it('logs job failures with safe identifiers only', async () => {
		const { logger, error } = makeLogger();
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
			logger,
		});

		await worker.start();
		instances[0].emit(
			'failed',
			{ id: '42', name: '__default__', attemptsMade: 2 },
			new Error('boom'),
		);

		expect(error).toHaveBeenCalledWith(
			'[worker:raw-commits] job failed',
			expect.objectContaining({
				jobId: '42',
				jobName: '__default__',
				attemptsMade: 2,
				error: 'boom',
			}),
		);

		await worker.stop();
	});

	it('logs worker (connection) errors', async () => {
		const { logger, error } = makeLogger();
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
			logger,
		});

		await worker.start();
		instances[0].emit('error', new Error('connection refused'));

		expect(error).toHaveBeenCalledWith(
			'[worker:raw-commits] worker error',
			expect.objectContaining({ error: 'connection refused' }),
		);

		await worker.stop();
	});

	it('rejects start when the connection fails and cleans up', async () => {
		readyError = new Error('no redis');
		const { logger } = makeLogger();
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
			logger,
		});

		await expect(worker.start()).rejects.toThrow('no redis');

		expect(worker.isRunning).toBe(false);
		expect(instances[0].close).toHaveBeenCalledWith(false);
	});

	it('stop is a no-op before start', async () => {
		const worker = new BaseWorker('raw-commits', noopProcessor);
		await expect(worker.stop()).resolves.toBeUndefined();
		expect(instances).toHaveLength(0);
	});

	it('stop gracefully drains in-flight jobs', async () => {
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
		});

		await worker.start();
		await worker.stop();

		expect(instances[0].close).toHaveBeenCalledWith(false);
		expect(worker.isRunning).toBe(false);
	});

	it('stop with force aborts in-flight jobs immediately', async () => {
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
		});

		await worker.start();
		await worker.stop(true);

		expect(instances[0].close).toHaveBeenCalledWith(true);
	});

	it('stop is idempotent', async () => {
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
		});

		await worker.start();
		await Promise.all([worker.stop(), worker.stop(), worker.stop()]);

		expect(instances[0].close).toHaveBeenCalledTimes(1);
	});

	it('stop does not hang when an in-flight job never finishes', async () => {
		vi.useFakeTimers();
		const { logger, error } = makeLogger();
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
			logger,
			shutdownTimeoutMs: 5_000,
		});

		await worker.start();
		instances[0].close.mockReturnValue(new Promise(() => {}));
		const stopped = worker.stop();
		vi.advanceTimersByTime(5_001);
		await expect(stopped).resolves.toBeUndefined();

		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('graceful shutdown timed out'),
		);
	});

	it('installs shutdown hooks on the configured signals', async () => {
		const signals = new EventEmitter();
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
			signals,
		});

		await worker.start();
		expect(signals.listenerCount('SIGTERM')).toBe(1);
		expect(signals.listenerCount('SIGINT')).toBe(1);

		signals.emit('SIGTERM');
		await vi.waitFor(() => {
			expect(instances[0].close).toHaveBeenCalledWith(false);
		});
	});

	it('removes shutdown hooks on stop', async () => {
		const signals = new EventEmitter();
		const worker = new BaseWorker('raw-commits', noopProcessor, {
			env: { REDIS_URL: 'redis://cache' },
			signals,
		});

		await worker.start();
		await worker.stop();

		expect(signals.listenerCount('SIGTERM')).toBe(0);
		expect(signals.listenerCount('SIGINT')).toBe(0);
	});
});
