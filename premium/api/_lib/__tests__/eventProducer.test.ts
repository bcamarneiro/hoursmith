/**
 * Tests for the event producer (ADA-721).
 *
 * `bullmq` is mocked at the module boundary (same trick as
 * `queueProvider.test.ts`) so the tests exercise the wiring — validation
 * before enqueue, lazy queue creation, atomic batch reject — without a live
 * Redis. Validation itself is covered in `eventSchemas.test.ts`; here the
 * producer is fed both valid and invalid events and the mock queue records
 * what would have been written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
	Queue: vi.fn(),
}));

import { Queue } from 'bullmq';

import { EventEnqueueError, EventProducer } from '../eventProducer.js';
import { EventValidationError, type ProductEvent } from '../eventSchemas.js';

const MockQueue = vi.mocked(Queue);

/** Minimal valid event; individual tests override fields they want to break. */
const validEvent: ProductEvent = {
	type: 'billing.subscription_active',
	occurredAt: '2026-07-01T12:00:00.000Z',
	payload: {
		customerId: 'cus_test123',
		subscriptionId: 'sub_test123',
		status: 'active',
		currentPeriodEnd: '2026-08-01T12:00:00.000Z',
	},
};

function makeQueueMock() {
	return {
		name: 'events',
		add: vi.fn().mockResolvedValue({ id: 'job-1' }),
		close: vi.fn().mockResolvedValue(undefined),
	};
}

beforeEach(() => {
	MockQueue.mockReset();
	MockQueue.mockImplementation(
		(name: string, opts: unknown) =>
			({
				name,
				opts,
				add: vi.fn().mockResolvedValue({ id: 'job-1' }),
				close: vi.fn().mockResolvedValue(undefined),
			}) as unknown as Queue,
	);
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe('EventProducer#send', () => {
	it('validates then enqueues a valid event and returns the job id', async () => {
		const queue = makeQueueMock();
		const producer = new EventProducer({ queue: queue as unknown as Queue });

		const jobId = await producer.send(validEvent);

		expect(jobId).toBe('job-1');
		expect(queue.add).toHaveBeenCalledTimes(1);
		expect(queue.add).toHaveBeenCalledWith('event', {
			event: validEvent,
		});
	});

	it('defaults a missing occurredAt to the current ISO timestamp', async () => {
		const queue = makeQueueMock();
		const producer = new EventProducer({ queue: queue as unknown as Queue });

		await producer.send({
			type: 'billing.subscription_active',
			payload: { customerId: 'c', subscriptionId: 's', status: 'active' },
		});

		const [, job] = queue.add.mock.calls[0] as [
			string,
			{ event: ProductEvent },
		];
		expect(job.event.occurredAt).toBeDefined();
		expect(Number.isNaN(Date.parse(job.event.occurredAt ?? ''))).toBe(false);
	});

	it('rejects an invalid event before enqueue (atomic reject)', async () => {
		const queue = makeQueueMock();
		const producer = new EventProducer({ queue: queue as unknown as Queue });

		await expect(
			producer.send({
				...validEvent,
				payload: { ...validEvent.payload, customerId: '' },
			}),
		).rejects.toBeInstanceOf(EventValidationError);

		expect(queue.add).not.toHaveBeenCalled();
	});

	it('rejects an unknown event type before enqueue', async () => {
		const queue = makeQueueMock();
		const producer = new EventProducer({ queue: queue as unknown as Queue });

		await expect(
			producer.send({
				type: 'billing.nope',
				occurredAt: '2026-07-01T12:00:00.000Z',
				payload: { customerId: 'c', subscriptionId: 's', status: 'active' },
			} as unknown as ProductEvent),
		).rejects.toBeInstanceOf(EventValidationError);

		expect(queue.add).not.toHaveBeenCalled();
	});

	it('wraps queue failures in EventEnqueueError', async () => {
		const queue = makeQueueMock();
		queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
		const producer = new EventProducer({ queue: queue as unknown as Queue });

		await expect(producer.send(validEvent)).rejects.toBeInstanceOf(
			EventEnqueueError,
		);
	});
});

describe('EventProducer#sendBatch', () => {
	it('enqueues every event and reports count + job ids', async () => {
		const queue = makeQueueMock();
		const producer = new EventProducer({ queue: queue as unknown as Queue });

		const result = await producer.sendBatch([validEvent, validEvent]);

		expect(result.enqueued).toBe(2);
		expect(result.jobIds).toEqual(['job-1', 'job-1']);
		expect(queue.add).toHaveBeenCalledTimes(2);
	});

	it('validates the whole batch before enqueueing anything', async () => {
		const queue = makeQueueMock();
		const producer = new EventProducer({ queue: queue as unknown as Queue });

		await expect(
			producer.sendBatch([
				validEvent,
				{ ...validEvent, payload: { ...validEvent.payload, status: '' } },
			]),
		).rejects.toBeInstanceOf(EventValidationError);

		expect(queue.add).not.toHaveBeenCalled();
	});

	it('wraps queue failures in EventEnqueueError', async () => {
		const queue = makeQueueMock();
		queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
		const producer = new EventProducer({ queue: queue as unknown as Queue });

		await expect(producer.sendBatch([validEvent])).rejects.toBeInstanceOf(
			EventEnqueueError,
		);
	});
});

describe('EventProducer queue lifecycle', () => {
	it('does not create the queue until the first send (lazy)', async () => {
		vi.stubEnv('REDIS_URL', 'redis://cache');
		MockQueue.mockClear();

		const producer = new EventProducer();
		expect(MockQueue).not.toHaveBeenCalled();

		await producer.send(validEvent);
		expect(MockQueue).toHaveBeenCalledTimes(1);
		expect(MockQueue).toHaveBeenCalledWith(
			'events',
			expect.objectContaining({
				connection: expect.objectContaining({ maxRetriesPerRequest: null }),
			}),
		);
	});

	it('reuses the lazy queue across sends', async () => {
		vi.stubEnv('REDIS_URL', 'redis://cache');
		MockQueue.mockClear();

		const producer = new EventProducer();
		await producer.send(validEvent);
		await producer.send(validEvent);

		expect(MockQueue).toHaveBeenCalledTimes(1);
	});

	it('close() closes an owned queue and is safe to repeat', async () => {
		vi.stubEnv('REDIS_URL', 'redis://cache');

		const producer = new EventProducer();
		await producer.send(validEvent);
		const owned = MockQueue.mock.results[0]?.value as {
			close: ReturnType<typeof vi.fn>;
		};

		await producer.close();
		await producer.close();

		// The second close is a no-op: the queue reference is dropped on the
		// first close, so the underlying connection is only closed once.
		expect(owned.close).toHaveBeenCalledTimes(1);
	});

	it('close() closes an injected queue', async () => {
		const queue = makeQueueMock();
		const producer = new EventProducer({ queue: queue as unknown as Queue });

		await producer.close();
		expect(queue.close).toHaveBeenCalledTimes(1);
	});
});
