/**
 * Rate-limiting fetch wrapper with automatic 429 retry
 * and concurrency control for API stability (ADA-609).
 *
 * Uses a sliding-window rate tracker and a concurrency queue
 * to prevent overwhelming upstream APIs (Jira, GitLab, etc.).
 * On 429 responses it retries with exponential backoff + jitter,
 * respecting the `Retry-After` header when present.
 *
 * Call sites that already use `fetch()` directly can switch to
 * `fetchWithRetry()` as a drop-in replacement — same signature,
 * same return type.
 */

import { ServiceError } from './serviceErrors';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RateLimiterConfig {
	/** Max concurrent in-flight requests (default 3). */
	maxConcurrent: number;
	/** Max requests per sliding window (default 100). */
	maxRequestsPerWindow: number;
	/** Window duration in ms (default 60 s). */
	windowMs: number;
	/** Max retries when the server responds 429 (default 3). */
	maxRetries: number;
	/** Base backoff in ms — doubles each retry, plus jitter (default 1000). */
	baseBackoffMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
	maxConcurrent: 3,
	maxRequestsPerWindow: 100,
	windowMs: 60_000,
	maxRetries: 3,
	baseBackoffMs: 1000,
};

/**
 * Set the rate-limiter configuration once before any calls.
 * Must be called before the first `fetchWithRetry` — after the first
 * call the config is locked and subsequent `configure()` calls are
 * ignored (a warning is logged).
 */
export function configure(config: Partial<RateLimiterConfig>): void {
	if (concurrencyQueue) {
		console.warn(
			'[rateLimiter] configure() called after first fetchWithRetry — ignored. ' +
				'Call configure() before any fetchWithRetry() to set defaults.',
		);
		return;
	}
	activeConfig = { ...DEFAULT_CONFIG, ...config };
}

// ---------------------------------------------------------------------------
// Sliding-window rate tracker
// ---------------------------------------------------------------------------

export class SlidingWindow {
	private timestamps: number[] = [];
	private readonly max: number;
	private readonly windowMs: number;

	constructor(max: number, windowMs: number) {
		this.max = max;
		this.windowMs = windowMs;
	}

	/** True if a new request slot is available (under the limit). */
	tryAcquire(): boolean {
		const now = Date.now();
		const cutoff = now - this.windowMs;
		this.timestamps = this.timestamps.filter((t) => t > cutoff);
		if (this.timestamps.length >= this.max) return false;
		this.timestamps.push(now);
		return true;
	}

	_reset(): void {
		this.timestamps = [];
	}
}

// ---------------------------------------------------------------------------
// Concurrency queue
// ---------------------------------------------------------------------------

export class ConcurrencyQueue {
	private active = 0;
	private readonly max: number;
	private readonly queue: Array<() => void> = [];

	constructor(max: number) {
		this.max = max;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) {
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			const next = this.queue.shift();
			if (next) next();
		}
	}
}

// ---------------------------------------------------------------------------
// Module-level state (shared across calls for cross-request rate limiting)
// ---------------------------------------------------------------------------

let activeConfig: RateLimiterConfig = { ...DEFAULT_CONFIG };
let windowTracker: SlidingWindow | null = null;
let concurrencyQueue: ConcurrencyQueue | null = null;

function getWindow(): SlidingWindow {
	if (!windowTracker) {
		windowTracker = new SlidingWindow(
			activeConfig.maxRequestsPerWindow,
			activeConfig.windowMs,
		);
	}
	return windowTracker;
}

function getConcurrency(): ConcurrencyQueue {
	if (!concurrencyQueue) {
		concurrencyQueue = new ConcurrencyQueue(activeConfig.maxConcurrent);
	}
	return concurrencyQueue;
}

// ---------------------------------------------------------------------------
// Retry / backoff helpers
// ---------------------------------------------------------------------------

/** Parse a `Retry-After` header value (seconds or HTTP-date). */
function parseRetryAfter(value: string | null): number | null {
	if (!value) return null;
	const seconds = Number(value);
	if (!Number.isNaN(seconds) && seconds > 0) return seconds;
	// Try HTTP-date format
	const ms = Date.parse(value);
	if (!Number.isNaN(ms))
		return Math.max(1, Math.ceil((ms - Date.now()) / 1000));
	return null;
}

/** Exponential backoff with full jitter. */
export function calculateBackoffMs(
	base: number,
	attempt: number,
	retryAfterHint: number | null,
): number {
	if (retryAfterHint !== null) return retryAfterHint * 1000;
	const cap = base * 2 ** attempt;
	return Math.random() * cap;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for `window.fetch` with rate limiting,
 * concurrency control, and automatic 429 retry with backoff.
 *
 * Throws a `ServiceError` if all retries are exhausted on a 429.
 * Preserves `AbortSignal` — an aborted request is not retried.
 */
export async function fetchWithRetry(
	input: RequestInfo,
	init?: RequestInit,
	config?: Partial<RateLimiterConfig>,
): Promise<Response> {
	if (config && !concurrencyQueue) {
		activeConfig = { ...DEFAULT_CONFIG, ...config };
		windowTracker = null;
		concurrencyQueue = null;
	} else if (config) {
		console.warn(
			'[rateLimiter] config provided after first fetchWithRetry — ignored. ' +
				'Use configure() before the first call to set defaults.',
		);
	}
	// If config is provided but the queue already exists, the config from the
	// first initializing call is kept — subsequent calls with the same config
	// share the existing queue / window. Call _resetState() first if a
	// different config is needed (e.g. in tests).

	const cfg = activeConfig;
	const signal = init?.signal;
	const win = getWindow();
	const conc = getConcurrency();

	// Wait for a rate-window slot before entering the concurrency queue.
	// This prevents the window spin-wait from occupying a concurrency slot,
	// so other requests that would pass the window check immediately are not
	// blocked while one request waits for the window to roll.
	while (!win.tryAcquire()) {
		if (signal?.aborted) {
			throw (
				signal.reason ??
				new DOMException('The operation was aborted', 'AbortError')
			);
		}
		await sleep(100);
	}

	return conc.run(async () => {
		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
			if (signal?.aborted) {
				throw (
					signal.reason ??
					new DOMException('The operation was aborted', 'AbortError')
				);
			}

			try {
				const res = await fetch(input, init);

				// Non-429: return as-is (caller handles 40x, 50x as they see fit)
				if (res.status !== 429) return res;

				// 429 — prepare to retry
				const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
				const delay = calculateBackoffMs(
					cfg.baseBackoffMs,
					attempt,
					retryAfter,
				);
				await sleep(delay);
				lastError = new ServiceError({
					kind: 'rate-limited',
					status: 429,
					source: typeof input === 'string' ? input : input.url,
					message: `Rate limited (429). Attempt ${attempt + 1}/${cfg.maxRetries + 1}.`,
				});
			} catch (err) {
				// Abort errors propagate immediately — never retry
				if (err instanceof DOMException && err.name === 'AbortError') throw err;
				if (err instanceof Error && err.name === 'AbortError') throw err;

				// Network/throw errors: retry if attempts remain
				if (attempt < cfg.maxRetries) {
					const delay = calculateBackoffMs(cfg.baseBackoffMs, attempt, null);
					await sleep(delay);
				}
				lastError = err instanceof Error ? err : new Error(String(err));
			}
		}

		// All attempts exhausted
		if (lastError instanceof ServiceError) throw lastError;
		throw new ServiceError({
			kind: 'network',
			source: typeof input === 'string' ? input : input.url,
			message:
				lastError?.message ??
				`Request failed after ${cfg.maxRetries + 1} attempts.`,
		});
	});
}

/**
 * Reset internal state (rate window, concurrency queue, config).
 * Only needed in tests — normal usage keeps state across calls.
 */
export function _resetState(): void {
	activeConfig = { ...DEFAULT_CONFIG };
	windowTracker = null;
	concurrencyQueue = null;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
