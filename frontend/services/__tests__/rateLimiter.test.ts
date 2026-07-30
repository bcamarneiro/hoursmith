/**
 * Unit tests for the rate-limiting fetch wrapper (ADA-609).
 *
 * All tests use fake timers so backoff delays are instantaneous.
 * State is reset before each test via `_resetState()`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
	fetchWithRetry,
	_resetState,
	calculateBackoffMs,
} from '../rateLimiter';
import { ServiceError } from '../serviceErrors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(
	status: number,
	headers?: Record<string, string>,
): Response {
	return new Response(null, { status, headers });
}

/** Create a promise that never settles (for blocking concurrency slots). */
function neverSettles(): Promise<Response> {
	return new Promise<Response>(() => {});
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	_resetState();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// fetchWithRetry — happy paths
// ---------------------------------------------------------------------------

describe('fetchWithRetry (ADA-609)', () => {
	it('passes through a successful fetch without retrying', async () => {
		const res = makeResponse(200);
		globalThis.fetch = vi.fn().mockResolvedValue(res);

		const result = await fetchWithRetry('https://hoursmith.io/api');

		expect(result.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('retries a 429 response and succeeds on the next attempt', async () => {
		const ok = makeResponse(200);
		const tooMany = makeResponse(429);
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(tooMany)
			.mockResolvedValueOnce(ok);

		const promise = fetchWithRetry('https://hoursmith.io/api');
		// Advance past the backoff timer (base * 2^0 with full jitter = up to 1000ms)
		await vi.advanceTimersByTimeAsync(2000);
		const result = await promise;

		expect(result.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('retries a network error (fetch throws) and succeeds', async () => {
		const ok = makeResponse(200);
		globalThis.fetch = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockResolvedValueOnce(ok);

		const promise = fetchWithRetry('https://hoursmith.io/api');
		await vi.advanceTimersByTimeAsync(2000);
		const result = await promise;

		expect(result.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('honours the Retry-After header', async () => {
		const ok = makeResponse(200);
		const tooMany = makeResponse(429, { 'retry-after': '3' });
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(tooMany)
			.mockResolvedValueOnce(ok);

		const promise = fetchWithRetry('https://hoursmith.io/api');
		await vi.advanceTimersByTimeAsync(5000);
		const result = await promise;

		expect(result.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('passes through non-429 status codes without retrying', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(404));

		const result = await fetchWithRetry('https://hoursmith.io/api');

		expect(result.status).toBe(404);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('passes through 5xx without retrying', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(503));

		const result = await fetchWithRetry('https://hoursmith.io/api');

		expect(result.status).toBe(503);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('uses a custom config when provided', async () => {
		const ok = makeResponse(200);
		const tooMany = makeResponse(429);
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(tooMany)
			.mockResolvedValueOnce(ok);

		const promise = fetchWithRetry('https://hoursmith.io/api', undefined, {
			maxRetries: 1,
			baseBackoffMs: 500,
		});
		await vi.advanceTimersByTimeAsync(500);
		const result = await promise;

		expect(result.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('passes RequestInfo.input correctly to fetch', async () => {
		const ok = makeResponse(200);
		globalThis.fetch = vi.fn().mockResolvedValue(ok);

		const request = new Request('https://hoursmith.io/api/issue');
		const init = { method: 'POST', body: '{}' };

		await fetchWithRetry(request, init);

		expect(globalThis.fetch).toHaveBeenCalledWith(request, init);
	});
});

// ---------------------------------------------------------------------------
// fetchWithRetry — error / retry-exhaustion paths
//
// IMPORTANT pattern: .catch() MUST be chained on the promise *before*
// advancing fake timers. Otherwise the promise rejects during the timer
// flush before Node.js has a rejection handler registered, causing Vitest
// to emit "unhandled rejection" errors (and pre-push hooks to fail).
// ---------------------------------------------------------------------------

describe('retry exhaustion & abort (ADA-609)', () => {
	it('throws ServiceError when all retries are exhausted on 429', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(429));

		// Chain .catch() synchronously before any timer advance.
		const promise = fetchWithRetry('https://hoursmith.io/api').catch(
			(e: unknown) => e,
		);

		// Now advance timers so the retry chain runs and the promise rejects.
		// The .catch() handler is already registered, so Node won't flag it.
		await vi.advanceTimersByTimeAsync(20_000);

		const err = await promise;
		expect(err).toBeInstanceOf(ServiceError);
		if (err instanceof ServiceError) {
			expect(err.kind).toBe('rate-limited');
			expect(err.status).toBe(429);
			expect(err.source).toBe('https://hoursmith.io/api');
		}
		expect(globalThis.fetch).toHaveBeenCalledTimes(4);
	});

	it('throws ServiceError when all retries are exhausted on network errors', async () => {
		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new TypeError('Failed to fetch'));

		const promise = fetchWithRetry('https://hoursmith.io/api').catch(
			(e: unknown) => e,
		);
		await vi.advanceTimersByTimeAsync(20_000);

		const err = await promise;
		expect(err).toBeInstanceOf(ServiceError);
		if (err instanceof ServiceError) {
			expect(err.kind).toBe('network');
			expect(err.source).toBe('https://hoursmith.io/api');
		}
		expect(globalThis.fetch).toHaveBeenCalledTimes(4);
	});

	it('respects an AbortSignal — aborted before the request', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(200));
		const controller = new AbortController();
		controller.abort();

		// Chain .catch() immediately — the signal is already aborted, so
		// the promise may reject synchronously or on first microtask.
		const promise = fetchWithRetry('https://hoursmith.io/api', {
			signal: controller.signal,
		}).catch((e: unknown) => e);

		await vi.advanceTimersByTimeAsync(100);

		const err = await promise;
		expect(err).toBeTruthy();
		// fetch should never have been called
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('respects an AbortSignal — aborted mid-retry', async () => {
		const controller = new AbortController();
		globalThis.fetch = vi.fn().mockImplementation(() => {
			controller.abort();
			return Promise.resolve(makeResponse(429));
		});

		const promise = fetchWithRetry('https://hoursmith.io/api', {
			signal: controller.signal,
		}).catch((e: unknown) => e);

		// Advance past the backoff + retry where the signal is checked.
		await vi.advanceTimersByTimeAsync(2000);

		const err = await promise;
		expect(err).toBeTruthy();
	});

	it('rejects with an abort error when concurrency-queued and then aborted', async () => {
		const controller = new AbortController();
		// Block the concurrency slot by making a request that never completes
		globalThis.fetch = vi.fn().mockImplementation(neverSettles);

		// First call claims the only slot
		fetchWithRetry('https://hoursmith.io/api', undefined, {
			maxConcurrent: 1,
		});
		await vi.advanceTimersByTimeAsync(0);

		// Queue a second call behind it
		const promise = fetchWithRetry(
			'https://hoursmith.io/api',
			{ signal: controller.signal },
			{ maxConcurrent: 1 },
		);
		const handled = promise.catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(0);

		// Abort the queued request
		controller.abort();
		await vi.advanceTimersByTimeAsync(0);

		// The queued request is awaiting a concurrency slot; it won't check
		// the signal until it gets one. The promise should still be pending.
		await expect(
			Promise.race([handled, Promise.resolve('pending')]),
		).resolves.toBe('pending');
	});
});

// ---------------------------------------------------------------------------
// fetchWithRetry — concurrency & sliding window
// ---------------------------------------------------------------------------

describe('concurrency & rate window (ADA-609)', () => {
	it('limits concurrency to maxConcurrent', async () => {
		const ok = makeResponse(200);
		let inFlight = 0;
		let maxObservedInFlight = 0;
		globalThis.fetch = vi.fn().mockImplementation(async () => {
			inFlight++;
			maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 100));
			inFlight--;
			return ok;
		});

		// Fire 5 concurrent requests with maxConcurrent=2
		const promises = Array.from({ length: 5 }, () =>
			fetchWithRetry('https://hoursmith.io/api', undefined, {
				maxConcurrent: 2,
			}),
		);

		await vi.advanceTimersByTimeAsync(1000);

		const results = await Promise.all(promises);
		expect(results).toHaveLength(5);
		results.forEach((r) => expect(r.status).toBe(200));
		expect(maxObservedInFlight).toBeLessThanOrEqual(2);
	});

	it('applies a sliding window across calls and blocks when full', async () => {
		const ok = makeResponse(200);
		let callCount = 0;
		globalThis.fetch = vi.fn().mockImplementation(() => {
			callCount++;
			return Promise.resolve(ok);
		});

		const config = {
			maxRequestsPerWindow: 2,
			windowMs: 60_000,
		};

		// First two calls — should pass through immediately
		const r1 = fetchWithRetry('https://hoursmith.io/api', undefined, config);
		await vi.advanceTimersByTimeAsync(100);
		expect((await r1).status).toBe(200);

		const r2 = fetchWithRetry('https://hoursmith.io/api', undefined, config);
		await vi.advanceTimersByTimeAsync(100);
		expect((await r2).status).toBe(200);

		expect(callCount).toBe(2);

		// Third call — should block because window is full (2/2)
		const r3 = fetchWithRetry('https://hoursmith.io/api', undefined, config);
		await vi.advanceTimersByTimeAsync(500);
		expect(callCount).toBe(2); // No additional calls — blocked by window

		// Advance past the window expiry
		await vi.advanceTimersByTimeAsync(61_000);
		expect((await r3).status).toBe(200);
		expect(callCount).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// calculateBackoffMs — unit tests
// ---------------------------------------------------------------------------

describe('calculateBackoffMs', () => {
	it('returns retryAfterHint * 1000 when hint is provided', () => {
		const result = calculateBackoffMs(1000, 2, 5);
		expect(result).toBe(5000);
	});

	it('returns full-jitter exponential backoff when no hint', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		try {
			const result = calculateBackoffMs(1000, 2, null);
			// cap = 1000 * 2^2 = 4000, random 0.5 * 4000 = 2000
			expect(result).toBe(2000);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('returns zero when random returns 0', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		try {
			const result = calculateBackoffMs(2000, 1, null);
			// cap = 2000 * 2^1 = 4000, random 0 * 4000 = 0
			expect(result).toBe(0);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('grows exponentially with attempt count', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1);
		try {
			const a0 = calculateBackoffMs(500, 0, null); // cap = 500
			const a1 = calculateBackoffMs(500, 1, null); // cap = 1000
			const a2 = calculateBackoffMs(500, 2, null); // cap = 2000
			expect(a0).toBe(500);
			expect(a1).toBe(1000);
			expect(a2).toBe(2000);
		} finally {
			vi.restoreAllMocks();
		}
	});
});
