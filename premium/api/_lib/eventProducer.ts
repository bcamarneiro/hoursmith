/**
 * Event Producer Module (ADA-721).
 *
 * Typed publisher for product events. Producers hand a `ProductEvent` to an
 * `EventProducer`; it validates the envelope and payload against the schema
 * registry (`eventSchemas`) and, when valid, enqueues it on the shared
 * `events` BullMQ queue. Consumers (workers) and producers agree on the queue
 * name via `QUEUE_NAMES.EVENTS` in `queueProvider`.
 *
 * Contract:
 *  - Validation happens BEFORE enqueue. An event with an unknown type or a
 *    malformed payload throws `EventValidationError` and nothing is written —
 *    a queue is a durable contract and junk must never be produced.
 *  - The Redis connection is resolved through the shared connection config
 *    (`redisConfig` via `queueProvider`); the queue is created lazily on
 *    first send so constructing a producer never touches the network.
 *  - `send` returns the BullMQ job id; `sendBatch` validates the whole batch
 *    up front (atomic reject — no partial writes on invalid input) then
 *    enqueues every event.
 */

import type { Queue } from 'bullmq';
import { type ProductEvent, validateProductEvent } from './eventSchemas.js';
import {
	closeQueue,
	createQueue,
	QUEUE_NAMES,
	type QueueFactoryOptions,
} from './queueProvider.js';

/** Payload of a job on the `events` queue. */
export interface EventJob {
	event: ProductEvent;
}

export interface EventProducerOptions {
	/** Connection config: env used to resolve Redis (defaults to `process.env`). */
	env?: QueueFactoryOptions['env'];
	/**
	 * Pre-built queue to publish to. Tests inject a mock here; when omitted,
	 * the producer lazily builds the shared `events` queue.
	 */
	queue?: Queue<EventJob>;
}

/** Outcome of a batch publish: every event was enqueued or none were. */
export interface EventBatchResult {
	enqueued: number;
	jobIds: string[];
}

/** Thrown when enqueueing a valid event fails (queue unavailable, etc.). */
export class EventEnqueueError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'EventEnqueueError';
	}
}

/**
 * Validated publisher for product events.
 *
 * Lazily owns the `events` BullMQ queue so serverless endpoints that never
 * publish don't pay connection setup. Call `close()` on shutdown; it is safe
 * to call repeatedly.
 */
export class EventProducer {
	private readonly options: EventProducerOptions;
	private queue: Queue<EventJob> | null;

	constructor(options: EventProducerOptions = {}) {
		this.options = options;
		this.queue = options.queue ?? null;
	}

	/**
	 * Validate and enqueue one event. Returns the BullMQ job id.
	 *
	 * Throws `EventValidationError` when the event fails schema validation
	 * (nothing is written) and `EventEnqueueError` when the queue rejects the
	 * job.
	 */
	async send(event: ProductEvent): Promise<string> {
		const normalized = validateProductEvent(event);
		const queue = this.getQueue();
		try {
			const job = await queue.add('event', {
				event: normalized,
			} satisfies EventJob);
			return job.id ?? '';
		} catch (err) {
			throw new EventEnqueueError(
				`Failed to enqueue ${normalized.type}: ${(err as Error).message}`,
				err,
			);
		}
	}

	/**
	 * Validate and enqueue a batch of events. Every event is validated before
	 * anything is enqueued, so an invalid batch is atomic: either all events
	 * are produced or none are.
	 */
	async sendBatch(events: ProductEvent[]): Promise<EventBatchResult> {
		const normalized = events.map((event) => validateProductEvent(event));
		const queue = this.getQueue();
		try {
			const jobs = await Promise.all(
				normalized.map((event) =>
					queue.add('event', { event } satisfies EventJob),
				),
			);
			return {
				enqueued: jobs.length,
				jobIds: jobs.map((job) => job.id ?? ''),
			};
		} catch (err) {
			throw new EventEnqueueError(
				`Failed to enqueue batch of ${normalized.length} event(s): ${(err as Error).message}`,
				err,
			);
		}
	}

	/** Close the underlying queue's Redis connection. Safe to call repeatedly. */
	async close(): Promise<void> {
		if (this.queue) {
			const queue = this.queue;
			this.queue = null;
			await closeQueue(queue);
		}
	}

	private getQueue(): Queue<EventJob> {
		if (!this.queue) {
			this.queue = createQueue<EventJob>(QUEUE_NAMES.EVENTS, {
				env: this.options.env,
			});
		}
		return this.queue;
	}
}

let defaultProducer: EventProducer | null = null;

/**
 * Process-wide singleton producer for request handlers. The underlying Redis
 * connection is created lazily on first send and reused for the lifetime of
 * the process; options are honored on the first call only. Use `new
 * EventProducer({ queue })` directly in tests instead of this helper.
 */
export function getEventProducer(
	options: EventProducerOptions = {},
): EventProducer {
	if (!defaultProducer) {
		defaultProducer = new EventProducer(options);
	}
	return defaultProducer;
}
