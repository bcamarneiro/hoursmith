/**
 * WorkerDaemon — background worker lifecycle, queue, and heartbeat monitor.
 *
 * Manages a Web Worker with request-ID multiplexing, idle timeout, health-check
 * pings, and automatic restart on crash. Generic over request/response payloads.
 *
 * ## Protocol
 *
 * Every message is a DaemonMessage discriminated by `type`:
 *   - `request`:  workerDaemon → worker (work to do; id correlates response)
 *   - `response`: worker → workerDaemon (result or error for a prior request)
 *   - `heartbeat`: workerDaemon → worker (ping); worker → workerDaemon (pong)
 *
 * ## Lifecycle
 *
 *   idle → starting → busy → idle   (normal flow)
 *                       → error     (worker crashed / heartbeat timeout)
 *   started → terminating → idle    (explicit stop or idle timeout)
 *
 * An `error` state triggers an automatic restart after `errorBackoffMs`.
 * Idle timeout (default 30 s) terminates the worker to free resources;
 * the next enqueue transparently restarts.
 *
 * ## Error handling
 *
 * Uses `ServiceError` from `frontend/services/serviceErrors.ts` for network-style
 * failures. Worker-level errors (uncaught exceptions, heartbeat loss, message
 * deserialization failures) are surfaced through the per-request promise rejects
 * AND the `onError` event stream.
 */

import { ServiceError } from '@/services/serviceErrors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated message envelope for daemon ↔ worker communication. */
export interface DaemonMessage<TReq = unknown, TRes = unknown> {
	/** Correlation id — every request gets a unique id, response echoes it. */
	id: string;
	type: 'request' | 'response' | 'heartbeat';
	/** Present on request-type messages (payload to process). */
	payload?: TReq | TRes;
	/** Present on response-type messages for error passthrough. */
	error?: string;
}

/** Immutable snapshot of daemon health. */
export interface DaemonStatus {
	state: DaemonState;
	/** Milliseconds since the worker was started (or restarted). */
	uptimeMs: number;
	/** Total request count since last start. */
	requestCount: number;
	/** ISO-8601 timestamp of the last successful heartbeat response. */
	lastHeartbeatAt: string | null;
}

export type DaemonState =
	| 'idle'
	| 'starting'
	| 'busy'
	| 'error'
	| 'terminating';

export interface WorkerDaemonOptions {
	/** Heartbeat interval in ms. Set to 0 to disable. Default 10 000 (10 s). */
	heartbeatIntervalMs?: number;
	/** Ms without a heartbeat response before declaring the worker dead. Default 30 000. */
	heartbeatTimeoutMs?: number;
	/** Ms of inactivity before terminating the worker. Set to 0 to disable. Default 30 000. */
	idleTimeoutMs?: number;
	/** Ms to wait before auto-restart after a crash. Default 2 000. */
	errorBackoffMs?: number;
	/** Human label used in error messages and logs. Default: "WorkerDaemon". */
	label?: string;
}

type PendingRequest<TRes = unknown> = {
	resolve: (value: TRes) => void;
	reject: (reason: unknown) => void;
	/** setTimeout handle for per-request timeout, if active. */
	timeoutId?: ReturnType<typeof setTimeout>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let uidCounter = 0;
function nextUid(): string {
	uidCounter += 1;
	return `wd-${uidCounter}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// WorkerDaemon
// ---------------------------------------------------------------------------

export class WorkerDaemon<TReq = unknown, TRes = unknown> {
	// -- config --
	private readonly heartbeatIntervalMs: number;
	private readonly heartbeatTimeoutMs: number;
	private readonly idleTimeoutMs: number;
	private readonly errorBackoffMs: number;
	private readonly label: string;

	// -- runtime state --
	private worker: Worker | null = null;
	private state: DaemonState = 'idle';
	private startedAt: number = 0;
	private lastHeartbeat: number = 0;
	private requestCount: number = 0;

	// -- pending request map (id → promise controls) --
	private pending = new Map<string, PendingRequest<TRes>>();

	// -- timers --
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;

	// -- event subscribers --
	private errorHandlers = new Set<(err: Error) => void>();
	private statusHandlers = new Set<(status: DaemonStatus) => void>();

	// -- stored worker URL (needed for restarts) --
	private readonly workerUrl: string | URL;
	private readonly workerOptions?: WorkerOptions;

	constructor(
		workerUrl: string | URL,
		opts: WorkerDaemonOptions = {},
		workerOptions?: WorkerOptions,
	) {
		this.workerUrl = workerUrl;
		this.workerOptions = workerOptions;
		this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 10_000;
		this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 30_000;
		this.idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
		this.errorBackoffMs = opts.errorBackoffMs ?? 2_000;
		this.label = opts.label ?? 'WorkerDaemon';
	}

	// -- lifecycle ----------------------------------------------------------

	/**
	 * Start (or restart) the worker. Safe to call multiple times — no-ops if
	 * already starting or busy. Resolves when the first heartbeat is received
	 * (or immediately if heartbeats are disabled).
	 */
	async start(): Promise<void> {
		if (this.state === 'busy' || this.state === 'starting') {
			return;
		}

		this.clearTimers();
		this.state = 'starting';
		this.emitStatus();

		try {
			this.worker = new Worker(this.workerUrl, {
				type: 'module',
				...this.workerOptions,
			});
		} catch (err) {
			this.setState('error');
			this.emitError(this.wrapError('Failed to construct worker', err));
			this.scheduleRestart();
			return;
		}

		this.worker.addEventListener('message', this.onWorkerMessage);
		this.worker.addEventListener('error', this.onWorkerError);

		// If heartbeats are enabled, wait for first pong before going "busy".
		if (this.heartbeatIntervalMs > 0) {
			this.startHeartbeat();
			// We transition to 'busy' on the first heartbeat response.
		} else {
			this.startedAt = Date.now();
			this.setState('busy');
		}

		// Start idle timer so unused workers don't stick around forever.
		this.resetIdleTimer();
	}

	/** Gracefully stop the worker. Pending requests are rejected. */
	stop(): void {
		if (this.state === 'idle' || this.state === 'terminating') {
			return;
		}

		this.setState('terminating');
		this.clearTimers();

		// Reject all pending — the worker is going away.
		this.pending.forEach((pr) => {
			pr.reject(
				new ServiceError({
					kind: 'network',
					source: this.label,
					message: `${this.label}: worker stopped while request was pending`,
				}),
			);
		});
		this.pending.clear();

		if (this.worker) {
			this.worker.removeEventListener('message', this.onWorkerMessage);
			this.worker.removeEventListener('error', this.onWorkerError);
			this.worker.terminate();
			this.worker = null;
		}

		this.setState('idle');
	}

	// -- queue / messaging --------------------------------------------------

	/**
	 * Enqueue a request to the worker. Returns a promise that resolves with the
	 * worker's response or rejects on error (crash, timeout, malformed message).
	 *
	 * If the daemon is idle (worker not running), it starts the worker first.
	 */
	enqueue(req: TReq): Promise<TRes> {
		return new Promise<TRes>((resolve, reject) => {
			const id = nextUid();
			this.pending.set(id, { resolve, reject });

			// Auto-start if idle.
			if (this.state === 'idle' || this.state === 'error') {
				void this.start().then(() => this.dispatchRequest(id, req));
			} else if (this.state === 'starting') {
				// Worker is spinning up — queue the dispatch after start completes.
				// We poll by listening to a one-shot status change to 'busy'.
				const unsub = this.onStatusChange((status) => {
					if (status.state === 'busy') {
						unsub();
						this.dispatchRequest(id, req);
					} else if (status.state === 'error') {
						unsub();
						// The start() call already scheduled a restart; reject.
						this.rejectPending(
							id,
							new ServiceError({
								kind: 'network',
								source: this.label,
								message: `${this.label}: failed to start — worker error`,
							}),
						);
					}
				});
			} else {
				this.dispatchRequest(id, req);
			}
		});
	}

	// -- status -------------------------------------------------------------

	getState(): DaemonState {
		return this.state;
	}

	getStatus(): DaemonStatus {
		return {
			state: this.state,
			uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
			requestCount: this.requestCount,
			lastHeartbeatAt: this.lastHeartbeat
				? new Date(this.lastHeartbeat).toISOString()
				: null,
		};
	}

	// -- events -------------------------------------------------------------

	/**
	 * Register an error listener. Returns an unsubscribe function.
	 * Errors include: worker construction failure, crash, heartbeat timeout,
	 * and message deserialization issues.
	 */
	onError(handler: (err: Error) => void): () => void {
		this.errorHandlers.add(handler);
		return () => void this.errorHandlers.delete(handler);
	}

	/**
	 * Register a status-change listener. Returns an unsubscribe function.
	 * Fires on every state transition (including same-state re-entry).
	 */
	onStatusChange(handler: (status: DaemonStatus) => void): () => void {
		this.statusHandlers.add(handler);
		return () => void this.statusHandlers.delete(handler);
	}

	// -- internal: messaging ------------------------------------------------

	private dispatchRequest(id: string, req: TReq): void {
		if (!this.worker) return;

		this.requestCount += 1;

		// Reset idle timer — the worker is being used.
		this.resetIdleTimer();

		const msg: DaemonMessage<TReq> = { id, type: 'request', payload: req };
		this.worker.postMessage(msg);
	}

	private onWorkerMessage = (evt: MessageEvent<DaemonMessage<TReq, TRes>>): void => {
		const msg = evt.data;
		if (!msg || typeof msg.id !== 'string' || typeof msg.type !== 'string') {
			this.emitError(
				new ServiceError({
					kind: 'unknown',
					source: this.label,
					message: `${this.label}: received malformed message from worker`,
				}),
			);
			return;
		}

		switch (msg.type) {
			case 'response': {
				const pr = this.pending.get(msg.id);
				if (!pr) return; // stale response for already-resolved request

				if (msg.error !== undefined && msg.error !== null) {
					pr.reject(
						new ServiceError({
							kind: 'unknown',
							source: this.label,
							message: `${this.label}: worker error: ${msg.error}`,
						}),
					);
				} else {
					pr.resolve(msg.payload as TRes);
				}

				this.pending.delete(msg.id);
				if (this.idleTimeoutMs > 0) this.resetIdleTimer();
				break;
			}

			case 'heartbeat': {
				// Worker sent us a heartbeat — either a pong or an unsolicited ping.
				// For simplicity, any heartbeat message from the worker resets the
				// heartbeat timeout and counts as a valid response.
				this.lastHeartbeat = Date.now();
				this.clearHeartbeatTimeout();

				// Transition from 'starting' if we were waiting for first heartbeat.
				if (this.state === 'starting') {
					this.startedAt = Date.now();
					this.setState('busy');
				}

				// Start the next heartbeat timeout (will fire if the interval + this
				// response together take longer than heartbeatTimeoutMs).
				if (this.heartbeatIntervalMs > 0) {
					this.startHeartbeatTimeout();
				}
				break;
			}

			default:
				// Unknown type — ignore gracefully.
				break;
		}
	};

	private onWorkerError = (evt: ErrorEvent): void => {
		const message =
			evt.message ||
			(evt.error instanceof Error ? evt.error.message : 'Unknown worker error');
		this.emitError(
			new ServiceError({
				kind: 'network',
				source: this.label,
				message: `${this.label}: worker crashed — ${message}`,
			}),
		);
		this.handleWorkerFailure();
	};

	// -- internal: heartbeat ------------------------------------------------

	private startHeartbeat(): void {
		this.clearHeartbeatTimer();

		// Send periodic pings.
		this.heartbeatTimer = setInterval(() => {
			if (!this.worker) return;
			const msg: DaemonMessage = { id: 'hb', type: 'heartbeat' };
			this.worker.postMessage(msg);
		}, this.heartbeatIntervalMs);

		this.startHeartbeatTimeout();
	}

	private startHeartbeatTimeout(): void {
		this.clearHeartbeatTimeout();
		this.heartbeatTimeoutTimer = setTimeout(() => {
			this.emitError(
				new ServiceError({
					kind: 'network',
					source: this.label,
					message: `${this.label}: heartbeat timeout — worker unresponsive`,
				}),
			);
			this.handleWorkerFailure();
		}, this.heartbeatTimeoutMs);
	}

	private clearHeartbeatTimer(): void {
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private clearHeartbeatTimeout(): void {
		if (this.heartbeatTimeoutTimer !== null) {
			clearTimeout(this.heartbeatTimeoutTimer);
			this.heartbeatTimeoutTimer = null;
		}
	}

	// -- internal: idle -----------------------------------------------------

	private resetIdleTimer(): void {
		if (this.idleTimeoutMs <= 0) return;
		if (this.idleTimer !== null) clearTimeout(this.idleTimer);

		this.idleTimer = setTimeout(() => {
			// Only terminate if truly idle (no pending requests).
			if (this.pending.size === 0) {
				this.stop();
			}
		}, this.idleTimeoutMs);
	}

	// -- internal: failure recovery -----------------------------------------

	private handleWorkerFailure(): void {
		this.setState('error');
		this.clearTimers();

		// Reject all pending requests.
		this.pending.forEach((pr) => {
			pr.reject(
				new ServiceError({
					kind: 'network',
					source: this.label,
					message: `${this.label}: worker failed`,
				}),
			);
		});
		this.pending.clear();

		// Detach from the dead worker.
		if (this.worker) {
			this.worker.removeEventListener('message', this.onWorkerMessage);
			this.worker.removeEventListener('error', this.onWorkerError);
			try {
				this.worker.terminate();
			} catch {
				/* already dead */
			}
			this.worker = null;
		}

		// Auto-restart after backoff.
		this.scheduleRestart();
	}

	private scheduleRestart(): void {
		if (this.errorBackoffMs <= 0) return; // no auto-restart
		if (this.restartTimer !== null) clearTimeout(this.restartTimer);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			void this.start();
		}, this.errorBackoffMs);
	}

	// -- internal: state management -----------------------------------------

	private setState(state: DaemonState): void {
		this.state = state;
		this.emitStatus();
	}

	private emitStatus(): void {
		const status = this.getStatus();
		this.statusHandlers.forEach((handler) => {
			try {
				handler(status);
			} catch {
				// Swallow handler errors so one bad listener doesn't break others.
			}
		});
	}

	private emitError(err: Error): void {
		this.errorHandlers.forEach((handler) => {
			try {
				handler(err);
			} catch {
				// Swallow handler errors.
			}
		});
	}

	// -- internal: helpers --------------------------------------------------

	private clearTimers(): void {
		this.clearHeartbeatTimer();
		this.clearHeartbeatTimeout();
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (this.restartTimer !== null) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
	}

	private rejectPending(id: string, err: unknown): void {
		const pr = this.pending.get(id);
		if (pr) {
			pr.reject(err);
			this.pending.delete(id);
		}
	}

	private wrapError(context: string, err: unknown): ServiceError {
		const inner = err instanceof Error ? err.message : String(err);
		return new ServiceError({
			kind: 'network',
			source: this.label,
			message: `${this.label}: ${context} — ${inner}`,
		});
	}
}
