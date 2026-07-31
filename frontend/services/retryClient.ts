/**
 * HTTP Retry Client — exponential backoff, request queuing, and a
 * deterministic retryable-status contract on top of `fetch` (ADA-693).
 *
 * Call sites that already use `fetch()` directly can switch to
 * `fetchWithRetry()` as a drop-in replacement — same signature, same return
 * type. The wrapper adds three guarantees:
 *
 *   1. **Deterministic retryable status codes.** `RETRYABLE_STATUS_CODES` is
 *      a single frozen source of truth: 408/425/429 (transient, client-paced)
 *      and 500/502/503/504 (upstream server failure). Auth/permission/bad-
 *      request statuses (401, 403, 404, 422, …) are NEVER retried — retrying
 *      a deterministic client error is wasted traffic and can look like
 *      credential hammering. Callers can override the set per client.
 *   2. **Configurable exponential backoff.** `RetryConfig` controls retry
 *      count, base/max delay, growth factor, and jitter strategy. The
 *      `Retry-After` header (seconds or HTTP-date) is honoured as an explicit
 *      server override. `calculateBackoffDelayMs` is a pure function.
 *   3. **Request queuing.** A shared `RequestQueue` (default concurrency 4)
 *      paces in-flight requests so a dashboard burst cannot fan out into Jira
 *      all at once, and a retrying request holds its queue slot while it backs
 *      off — queued requests naturally pace themselves during upstream
 *      degradation.
 *
 * Abort semantics follow the rest of the codebase (ADA-456): an aborted
 * request throws `AbortError` immediately and is never retried.
 */

// ---------------------------------------------------------------------------
// Deterministic retryable status codes
// ---------------------------------------------------------------------------

/**
 * The canonical set of HTTP statuses the retry client will retry by default.
 *
 * Frozen and exported so tests, callers, and error mappers all agree on one
 * definition. Never retried: 4xx client errors that are deterministic
 * (401/403/404/422/…), and 1xx/2xx/3xx responses.
 */
export const RETRYABLE_STATUS_CODES: readonly number[] = Object.freeze([
	408, // Request Timeout — the server timed out waiting for the request
	425, // Too Early — server asks the client to replay
	429, // Too Many Requests — rate limited
	500, // Internal Server Error
	502, // Bad Gateway
	503, // Service Unavailable
	504, // Gateway Timeout
]);

/** True when `status` is in the retryable set. */
export function isRetryableStatus(
	status: number,
	retryableStatuses: readonly number[] = RETRYABLE_STATUS_CODES,
): boolean {
	return retryableStatuses.includes(status);
}

// ---------------------------------------------------------------------------
// Backoff configuration
// ---------------------------------------------------------------------------

export type BackoffJitter = 'none' | 'full' | 'equal';

export interface RetryConfig {
	/** Max automatic retries after the initial attempt (default 3). */
	maxRetries: number;
	/** Base backoff in ms — grows by `factor` per retry (default 1000). */
	baseDelayMs: number;
	/** Upper cap for the exponential backoff in ms (default 30 s). */
	maxDelayMs: number;
	/** Exponential growth factor per retry; must be >= 1 (default 2). */
	factor: number;
	/**
	 * Jitter strategy applied to every computed delay (default 'full'):
	 * - `none`  — exact exponential delay (`min(base * factor^attempt, max)`);
	 * - `full`  — uniform in `[0, delay)` — thundering-herd safe (default);
	 * - `equal` — uniform in `[delay/2, delay]` — preserves a floor.
	 */
	jitter: BackoffJitter;
	/**
	 * Statuses considered retryable. Defaults to the deterministic
	 * `RETRYABLE_STATUS_CODES` set; override per client when a service has a
	 * different contract (e.g. add 409 for a specific endpoint).
	 */
	retryableStatuses?: readonly number[];
	/**
	 * Retry transient network failures (fetch rejects, e.g. `TypeError:
	 * Failed to fetch`). Defaults to true. Never applies to aborts.
	 */
	retryOnNetworkError: boolean;
	/** Max requests admitted into the shared queue at once (default 4). */
	maxConcurrent: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = Object.freeze({
	maxRetries: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30_000,
	factor: 2,
	jitter: 'full',
	retryOnNetworkError: true,
	maxConcurrent: 4,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse a `Retry-After` header value — either delay-seconds or an HTTP-date
 * (`Date.parse`able). Returns seconds, or null when unparseable/absent.
 */
export function parseRetryAfter(value: string | null): number | null {
	if (!value) return null;
	// Numeric form (delta-seconds) is authoritative — never falls through to
	// the HTTP-date branch, which would mis-parse values like '0' as a year.
	const seconds = Number(value);
	if (!Number.isNaN(seconds)) return seconds > 0 ? seconds : null;
	const ms = Date.parse(value);
	if (!Number.isNaN(ms))
		return Math.max(1, Math.ceil((ms - Date.now()) / 1000));
	return null;
}

/**
 * Compute the delay before retry `attempt` (0 = first retry).
 *
 * Exponential with cap: `min(base * factor^attempt, maxDelayMs)`, then the
 * configured jitter. A `retryAfterHint` (seconds) overrides the calculation
 * entirely — the server's explicit instruction wins, so no jitter is applied.
 * Pure — no clocks, no randomness under `jitter: 'none'`.
 */
export function calculateBackoffDelayMs(
	attempt: number,
	config: Partial<RetryConfig> = {},
	retryAfterHint: number | null = null,
): number {
	if (retryAfterHint !== null && retryAfterHint > 0)
		return retryAfterHint * 1000;

	const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
	const raw = Math.min(cfg.baseDelayMs * cfg.factor ** attempt, cfg.maxDelayMs);

	switch (cfg.jitter) {
		case 'none':
			return raw;
		case 'equal':
			return raw / 2 + Math.random() * (raw / 2);
		default:
			// 'full' — uniform in [0, raw); also the default strategy.
			return Math.random() * raw;
	}
}

// ---------------------------------------------------------------------------
// Request queue
// ---------------------------------------------------------------------------

/**
 * FIFO concurrency-limited queue. `run(fn)` executes `fn` once a slot frees
 * up, keeping at most `maxConcurrent` promises in flight.
 */
export class RequestQueue {
	private readonly maxConcurrent: number;
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(maxConcurrent: number) {
		if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
			throw new RangeError(
				`[retryClient] maxConcurrent must be a positive integer, got ${maxConcurrent}`,
			);
		}
		this.maxConcurrent = maxConcurrent;
	}

	/** Number of requests currently running. */
	get inFlight(): number {
		return this.active;
	}

	/** Number of requests waiting for a slot. */
	get pending(): number {
		return this.waiting.length;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.maxConcurrent) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}

// ---------------------------------------------------------------------------
// Module-level state (shared across calls for cross-request pacing)
// ---------------------------------------------------------------------------

let activeConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG };
let queue: RequestQueue | null = null;

/**
 * Set the retry-client defaults before any request. Must be called before the
 * first `fetchWithRetry` — after the queue exists the config is locked and
 * subsequent calls are ignored (a warning is logged). Per-call config passed
 * to `fetchWithRetry` always wins for that call.
 */
export function configureRetryClient(config: Partial<RetryConfig>): void {
	if (queue) {
		console.warn(
			'[retryClient] configureRetryClient() called after first fetchWithRetry — ignored. ' +
				'Call it before any fetchWithRetry() to set defaults.',
		);
		return;
	}
	activeConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
	validateConfig(activeConfig);
}

/** Validate a fully-resolved config; throws RangeError on nonsense values. */
function validateConfig(config: RetryConfig): void {
	if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) {
		throw new RangeError(
			`[retryClient] maxRetries must be a non-negative integer, got ${config.maxRetries}`,
		);
	}
	if (!Number.isFinite(config.baseDelayMs) || config.baseDelayMs < 0) {
		throw new RangeError(
			`[retryClient] baseDelayMs must be a non-negative number, got ${config.baseDelayMs}`,
		);
	}
	if (!Number.isFinite(config.maxDelayMs) || config.maxDelayMs < 0) {
		throw new RangeError(
			`[retryClient] maxDelayMs must be a non-negative number, got ${config.maxDelayMs}`,
		);
	}
	if (config.maxDelayMs < config.baseDelayMs) {
		throw new RangeError(
			`[retryClient] maxDelayMs (${config.maxDelayMs}) must be >= baseDelayMs (${config.baseDelayMs})`,
		);
	}
	if (!Number.isFinite(config.factor) || config.factor < 1) {
		throw new RangeError(
			`[retryClient] factor must be a number >= 1, got ${config.factor}`,
		);
	}
	if (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1) {
		throw new RangeError(
			`[retryClient] maxConcurrent must be a positive integer, got ${config.maxConcurrent}`,
		);
	}
}

function getQueue(config: RetryConfig): RequestQueue {
	if (!queue) queue = new RequestQueue(config.maxConcurrent);
	return queue;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for `window.fetch` with deterministic retry on
 * retryable statuses (and, by default, network failures), exponential backoff
 * with jitter, `Retry-After` support, and cross-request queueing.
 *
 * - Non-retryable responses are returned as-is on the first attempt.
 * - Retryable responses are retried up to `maxRetries` times; when exhausted,
 *   the LAST response is returned so callers keep their existing
 *   `if (!res.ok)` error mapping (e.g. `fromHttpResponseAsync`).
 * - Network failures are retried when `retryOnNetworkError`; when exhausted,
 *   the underlying error is rethrown unchanged (drop-in `fetch` semantics).
 * - Aborts throw `AbortError` immediately and are never retried.
 */
export async function fetchWithRetry(
	input: RequestInfo,
	init?: RequestInit,
	config?: Partial<RetryConfig>,
): Promise<Response> {
	const cfg = { ...activeConfig, ...config };
	validateConfig(cfg);
	const signal = init?.signal ?? undefined;
	const q = getQueue(cfg);

	return q.run(async () => {
		let lastError: unknown = null;

		for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
			if (signal?.aborted) throw abortError(signal);

			try {
				const res = await fetch(input, init);

				if (res.ok || !isRetryableStatus(res.status, cfg.retryableStatuses)) {
					return res;
				}
				if (attempt >= cfg.maxRetries) return res;

				const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
				await sleep(calculateBackoffDelayMs(attempt, cfg, retryAfter), signal);
			} catch (err) {
				if (isAbortError(err)) throw err;

				lastError = err;
				if (!cfg.retryOnNetworkError || attempt >= cfg.maxRetries) throw err;

				await sleep(calculateBackoffDelayMs(attempt, cfg, null), signal);
			}
		}

		// Unreachable in practice — the loop returns or throws on every path.
		throw lastError instanceof Error
			? lastError
			: new TypeError('fetch failed');
	});
}

/**
 * Reset module state (config + queue). Only needed in tests — normal usage
 * keeps the queue across calls so pacing is shared app-wide.
 */
export function _resetRetryClient(): void {
	activeConfig = { ...DEFAULT_RETRY_CONFIG };
	queue = null;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function abortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	return new DOMException('The operation was aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === 'AbortError') ||
		(error instanceof Error && error.name === 'AbortError')
	);
}
