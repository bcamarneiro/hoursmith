/**
 * Base worker for premium background jobs (ADA-699).
 *
 * Wraps a BullMQ `Worker` with the shared production conventions of the
 * premium API:
 *
 *  - Redis connection resolved through `redisConfig.js` — the same source of
 *    truth as the queue provider, so producers and consumers always agree.
 *  - Structured error logging: job failures and connection errors are logged
 *    with the queue name and safe identifiers (never job payloads, which can
 *    contain user data).
 *  - Graceful shutdown hooks: `start()` installs `SIGTERM`/`SIGINT` handlers
 *    (injectable for tests) and `stop()` drains in-flight jobs before closing
 *    the Redis connection. A `shutdownTimeoutMs` cap keeps a stuck job from
 *    hanging shutdown forever; pass `force: true` to abort in-flight work.
 *
 * Concrete workers supply only a queue name and a job processor; this class
 * owns lifecycle and observability so consumers stay small and consistent.
 */

import { type Job, type Processor, Worker, type WorkerOptions } from 'bullmq';

import { type RedisEnv, redisOptions } from './redisConfig.js';

/**
 * A job processor: receives the job and resolves when it is fully handled.
 * Processors should be async (return a Promise); the processor signature is
 * BullMQ's canonical `Processor` so sandboxed and standard workers agree.
 */
export type JobProcessor<Payload = unknown> = Processor<Payload>;

/** Minimal structured logger surface used by the base worker. */
export interface WorkerLogger {
	error(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
}

/**
 * The subset of `process` the worker installs shutdown hooks on. Injectable so
 * tests can drive signals without touching the real process.
 */
export interface SignalRegistry {
	on(signal: NodeJS.Signals, listener: () => void): unknown;
	removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface BaseWorkerOptions {
	/** Env to resolve the Redis connection from; defaults to `process.env`. Tests inject here. */
	env?: RedisEnv;
	/** Structured logger; defaults to console tagged with the queue name. */
	logger?: WorkerLogger;
	/**
	 * Graceful shutdown timeout in ms. If in-flight jobs do not finish within
	 * this window, `stop()` logs an error and returns anyway so the process
	 * supervisor can escalate. Defaults to 30s.
	 */
	shutdownTimeoutMs?: number;
	/** Signal registry for shutdown hooks; defaults to `process`. Tests inject here. */
	signals?: SignalRegistry;
	/** Extra BullMQ worker options (e.g. `concurrency`). `connection` is always managed here. */
	workerOptions?: Omit<WorkerOptions, 'connection'>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

function consoleLogger(queueName: string): WorkerLogger {
	const tag = `[worker:${queueName}]`;
	return {
		error: (message, context = {}) =>
			console.error(`${tag} ${message}`, JSON.stringify(context)),
		info: (message, context = {}) =>
			console.info(`${tag} ${message}`, JSON.stringify(context)),
	};
}

export class BaseWorker<Payload = unknown> {
	readonly queueName: string;

	private readonly processor: JobProcessor<Payload>;
	private readonly env: RedisEnv;
	private readonly logger: WorkerLogger;
	private readonly shutdownTimeoutMs: number;
	private readonly signals: SignalRegistry;
	private readonly workerOptions: Omit<WorkerOptions, 'connection'> | undefined;

	private worker: Worker<Payload> | null = null;
	private stopping: Promise<void> | null = null;
	private signalHandlers: Array<[NodeJS.Signals, () => void]> = [];

	constructor(
		queueName: string,
		processor: JobProcessor<Payload>,
		options: BaseWorkerOptions = {},
	) {
		this.queueName = queueName;
		this.processor = processor;
		this.env = options.env ?? process.env;
		this.logger = options.logger ?? consoleLogger(queueName);
		this.shutdownTimeoutMs =
			options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
		this.signals = options.signals ?? process;
		this.workerOptions = options.workerOptions;
	}

	/** True while a BullMQ worker exists and is not mid-shutdown. */
	get isRunning(): boolean {
		return this.worker !== null;
	}

	/**
	 * Start consuming jobs. Idempotent: a no-op while already running (or
	 * while shutting down). Resolves once the worker has connected to Redis so
	 * a misconfigured deploy fails fast instead of silently churning.
	 */
	async start(): Promise<void> {
		if (this.worker !== null || this.stopping !== null) {
			return;
		}

		const worker = new Worker<Payload>(this.queueName, this.processor, {
			...this.workerOptions,
			connection: redisOptions(this.env),
		});
		this.worker = worker;

		worker.on('failed', (job: Job<Payload> | undefined, error: Error) => {
			this.logger.error('job failed', {
				jobId: job?.id,
				jobName: job?.name,
				attemptsMade: job?.attemptsMade,
				error: error?.message ?? String(error),
			});
		});
		worker.on('error', (error: Error) => {
			this.logger.error('worker error', {
				error: error?.message ?? String(error),
			});
		});

		for (const signal of SHUTDOWN_SIGNALS) {
			const handler = () => {
				void this.stop();
			};
			this.signalHandlers.push([signal, handler]);
			this.signals.on(signal, handler);
		}

		try {
			await worker.waitUntilReady();
			this.logger.info('ready');
		} catch (error) {
			this.logger.error('failed to connect', {
				error: error instanceof Error ? error.message : String(error),
			});
			await this.stop(true);
			throw error;
		}
	}

	/**
	 * Graceful shutdown hook: remove signal handlers, stop accepting new jobs,
	 * wait for in-flight jobs (up to `shutdownTimeoutMs`), then close the
	 * Redis connection. Idempotent and safe to call before `start()`. Pass
	 * `force: true` to abort in-flight jobs immediately.
	 */
	async stop(force = false): Promise<void> {
		if (this.stopping) {
			return this.stopping;
		}
		for (const [signal, handler] of this.signalHandlers) {
			this.signals.removeListener(signal, handler);
		}
		this.signalHandlers = [];

		const worker = this.worker;
		if (!worker) {
			return;
		}
		this.worker = null;

		this.stopping = this.drain(worker, force).finally(() => {
			this.stopping = null;
		});
		return this.stopping;
	}

	/** Alias for `stop()` so callers can use either verb. */
	close(): Promise<void> {
		return this.stop();
	}

	private async drain(worker: Worker<Payload>, force: boolean): Promise<void> {
		if (force) {
			await worker.close(true).catch((error: unknown) => {
				this.logger.error('close failed', {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			return;
		}

		const closePromise = worker.close(false).catch((error: unknown) => {
			this.logger.error('close failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		try {
			await Promise.race([
				closePromise,
				new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						timedOut = true;
						this.logger.error(
							`graceful shutdown timed out after ${this.shutdownTimeoutMs}ms; in-flight jobs may still be running`,
						);
						resolve();
					}, this.shutdownTimeoutMs);
				}),
			]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}

		// If graceful close timed out, force-close to prevent a zombie
		// worker that would still be consuming jobs. Calling close(true)
		// on an already-closed worker is a safe no-op in BullMQ.
		if (timedOut) {
			try {
				await worker.close(true);
			} catch {
				// swallow — worker already torn down
			}
		}
	}
}
