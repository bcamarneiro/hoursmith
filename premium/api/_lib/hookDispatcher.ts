/**
 * Asynchronous hook dispatcher (ADA-741).
 *
 * A dependency-free, edge-runtime-compatible event bus for premium
 * workflows: hooks are named events, listeners are (possibly async)
 * functions registered per hook. `emit` delivers to every listener
 * asynchronously, awaits each listener's promise, and aggregates the
 * per-listener outcomes into a single `HookDispatchResult` — a single
 * failing listener can never reject `emit` or block the others.
 *
 * Guarantees:
 *   - Hook names are validated (lowercase kebab-case, <= 64 chars) and
 *     registration fails loudly on a malformed name or non-function
 *     listener — a wiring bug we want to surface, not paper over.
 *   - Firing is always asynchronous: listeners are invoked on a
 *     microtask after `emit` returns, never synchronously in the caller's
 *     stack, and the listener snapshot is taken up front so listeners
 *     added or removed during a dispatch do not affect the in-flight batch.
 *   - Error boundary: every listener runs in its own guarded scope. Sync
 *     throws and async rejections are captured per-listener (and an
 *     optional per-listener timeout turns hangs into reported errors);
 *     `emit` never rejects. Failures are surfaced through the configured
 *     error handler (defaults to console.error) for observability.
 *   - Reads are snapshots; listeners cannot mutate registry state through
 *     a query result.
 *
 * Module state is process-local; import the `hookDispatcher` singleton
 * for production call sites, or construct fresh instances in tests.
 */

export type HookListener<T = unknown> = (
	payload: T,
) => void | Promise<void>;

/** Per-listener result of a single dispatch. */
export interface ListenerOutcome {
	/** Whether the listener completed without throwing/rejecting. */
	ok: boolean;
	/** Present when the listener failed; the normalized Error. */
	error?: Error;
	/** Wall-clock time spent in the listener, in milliseconds. */
	durationMs: number;
}

/** Aggregate of every listener result for one `emit` call. */
export interface HookDispatchResult {
	hook: string;
	/** Number of listeners the dispatch was delivered to. */
	listenerCount: number;
	/** Count of listeners that completed successfully. */
	fulfilled: number;
	/** Count of listeners that failed (threw, rejected, or timed out). */
	rejected: number;
	/** One outcome per listener, in registration order. */
	outcomes: readonly ListenerOutcome[];
}

/** Context handed to the error handler when a listener fails. */
export interface HookErrorEvent {
	hook: string;
	error: Error;
	listener: HookListener;
}

export type HookErrorHandler = (event: HookErrorEvent) => void;

export interface EmitOptions {
	/**
	 * Optional per-listener cap in milliseconds. A listener that has not
	 * settled by then is reported as a timeout error. Omitted = no cap.
	 */
	timeoutMs?: number;
}

export type HookDispatcherErrorCode =
	| 'invalid-hook'
	| 'invalid-listener'
	| 'invalid-options';

export class HookDispatcherError extends Error {
	constructor(
		readonly code: HookDispatcherErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'HookDispatcherError';
	}
}

const HOOK_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_HOOK_LENGTH = 64;
const DEFAULT_TIMEOUT_MESSAGE = (hook: string, timeoutMs: number) =>
	`hook "${hook}" listener did not settle within ${timeoutMs}ms`;

/** Normalize any thrown value into an Error without losing the message. */
function toError(value: unknown): Error {
	if (value instanceof Error) {
		return value;
	}
	if (typeof value === 'string') {
		return new Error(value);
	}
	return new Error(`listener failed with non-Error value: ${String(value)}`);
}

/** Race a promise against a timeout, clearing the timer when it settles. */
function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(message));
		}, timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function assertHookName(hook: string): void {
	if (hook.length === 0 || hook.length > MAX_HOOK_LENGTH) {
		throw new HookDispatcherError(
			'invalid-hook',
			`hook name must be 1-${MAX_HOOK_LENGTH} characters, got ${JSON.stringify(hook)}`,
		);
	}
	if (!HOOK_PATTERN.test(hook)) {
		throw new HookDispatcherError(
			'invalid-hook',
			`hook name must be lowercase kebab-case, got ${JSON.stringify(hook)}`,
		);
	}
}

function assertListener(listener: unknown): void {
	if (typeof listener !== 'function') {
		throw new HookDispatcherError(
			'invalid-listener',
			'listener must be a function',
		);
	}
}

function assertTimeoutMs(timeoutMs: number | undefined): void {
	if (timeoutMs === undefined) {
		return;
	}
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new HookDispatcherError(
			'invalid-options',
			'timeoutMs must be a positive finite number when provided',
		);
	}
}

export class HookDispatcher {
	private readonly listeners = new Map<string, Set<HookListener>>();
	private errorHandler: HookErrorHandler | null = (event) => {
		// Default to console for observability; override with
		// setErrorHandler for production sinks (audit log, metrics).
		console.error(
			`[hook-dispatcher] hook "${event.hook}" listener failed:`,
			event.error,
		);
	};

	/**
	 * Register a listener for a hook. Returns an unsubscribe function;
	 * calling it removes the listener (idempotent).
	 */
	on<T>(hook: string, listener: HookListener<T>): () => void {
		assertHookName(hook);
		assertListener(listener);
		const stored = listener as HookListener;
		let bucket = this.listeners.get(hook);
		if (bucket === undefined) {
			bucket = new Set<HookListener>();
			this.listeners.set(hook, bucket);
		}
		bucket.add(stored);
		return () => {
			this.off(hook, stored);
		};
	}

	/**
	 * Register a listener that fires at most once: it is removed before
	 * being invoked, so a throwing or async listener cannot re-arm it.
	 * Returns an unsubscribe function.
	 */
	once<T>(hook: string, listener: HookListener<T>): () => void {
		assertHookName(hook);
		assertListener(listener);
		const stored = listener as HookListener;
		const wrapped: HookListener = (payload) => {
			this.off(hook, wrapped);
			return stored(payload);
		};
		let bucket = this.listeners.get(hook);
		if (bucket === undefined) {
			bucket = new Set<HookListener>();
			this.listeners.set(hook, bucket);
		}
		bucket.add(wrapped);
		return () => {
			this.off(hook, wrapped);
		};
	}

	/**
	 * Remove a previously registered listener. Returns true when the
	 * listener was registered (and removed), false otherwise. Unknown or
	 * malformed hook names are treated as "nothing registered".
	 */
	off(hook: string, listener: HookListener): boolean {
		const bucket = this.listeners.get(hook);
		if (bucket === undefined) {
			return false;
		}
		const removed = bucket.delete(listener);
		if (bucket.size === 0) {
			this.listeners.delete(hook);
		}
		return removed;
	}

	/** True when at least one listener is registered for the hook. */
	hasListeners(hook: string): boolean {
		return (this.listeners.get(hook)?.size ?? 0) > 0;
	}

	/** Number of listeners registered for the hook. */
	listenerCount(hook: string): number {
		return this.listeners.get(hook)?.size ?? 0;
	}

	/** Snapshot of the listeners registered for the hook, in registration order. */
	getListeners(hook: string): readonly HookListener[] {
		const bucket = this.listeners.get(hook);
		return bucket === undefined ? [] : [...bucket];
	}

	/**
	 * Remove every listener for one hook, or every listener in the
	 * dispatcher when called without arguments (teardown / tests).
	 */
	clear(hook?: string): void {
		if (hook === undefined) {
			this.listeners.clear();
			return;
		}
		this.listeners.delete(hook);
	}

	/**
	 * Set the handler invoked for every failed listener. Pass null to
	 * disable reporting. The handler itself is guarded — a throwing
	 * handler never escapes the dispatcher.
	 */
	setErrorHandler(handler: HookErrorHandler | null): void {
		this.errorHandler = handler;
	}

	/**
	 * Fire a hook asynchronously and await every listener. Delivery is
	 * scheduled on a microtask (never synchronous), the listener set is
	 * snapshotted up front, and each listener is guarded by its own error
	 * boundary. Resolves with the aggregated result; never rejects — use
	 * `HookDispatchResult.rejected` / `outcomes` to inspect failures.
	 * Invalid hook names and invalid options throw synchronously (a
	 * programming error, same as `on`), before any dispatch is scheduled.
	 */
	emit<T>(
		hook: string,
		payload: T,
		options: EmitOptions = {},
	): Promise<HookDispatchResult> {
		assertHookName(hook);
		assertTimeoutMs(options.timeoutMs);
		return this.dispatch(hook, payload, options.timeoutMs);
	}

	private async dispatch<T>(
		hook: string,
		payload: T,
		timeoutMs: number | undefined,
	): Promise<HookDispatchResult> {
		const snapshot = this.getListeners(hook);
		if (snapshot.length === 0) {
			return {
				hook,
				listenerCount: 0,
				fulfilled: 0,
				rejected: 0,
				outcomes: [],
			};
		}
		// Defer to a microtask so firing is always asynchronous and the
		// caller's stack has returned before any listener runs.
		await Promise.resolve();
		const outcomes = await Promise.all(
			snapshot.map((listener) => this.deliver(listener, hook, payload, timeoutMs)),
		);
		const fulfilled = outcomes.filter((outcome) => outcome.ok).length;
		return {
			hook,
			listenerCount: snapshot.length,
			fulfilled,
			rejected: outcomes.length - fulfilled,
			outcomes,
		};
	}

	/**
	 * Fire a hook without awaiting the outcome. Listener failures are
	 * captured by the error boundary and reported to the error handler —
	 * never an unhandled rejection.
	 */
	emitAndForget<T>(hook: string, payload: T, options: EmitOptions = {}): void {
		void this.emit(hook, payload, options);
	}

	private async deliver<T>(
		listener: HookListener,
		hook: string,
		payload: T,
		timeoutMs: number | undefined,
	): Promise<ListenerOutcome> {
		const startedAt = Date.now();
		try {
			const invocation = Promise.resolve().then(() => listener(payload));
			const settled =
				timeoutMs === undefined
					? invocation
					: withTimeout(
							invocation,
							timeoutMs,
							DEFAULT_TIMEOUT_MESSAGE(hook, timeoutMs),
						);
			await settled;
			return { ok: true, durationMs: Date.now() - startedAt };
		} catch (rawError) {
			const error = toError(rawError);
			this.reportError(hook, error, listener);
			return {
				ok: false,
				error,
				durationMs: Date.now() - startedAt,
			};
		}
	}

	private reportError(hook: string, error: Error, listener: HookListener): void {
		if (this.errorHandler === null) {
			return;
		}
		try {
			this.errorHandler({ hook, error, listener });
		} catch {
			// The error boundary never propagates handler failures.
		}
	}
}

/** Process-wide singleton for production call sites. */
export const hookDispatcher = new HookDispatcher();
