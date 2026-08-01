/**
 * Tests for the HTTP retry client (ADA-693): deterministic retryable status
 * definition, configurable exponential backoff, request queuing, and the
 * drop-in `fetchWithRetry` wrapper.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetRetryClient,
	_resetRetryLogger,
	calculateBackoffDelayMs,
	configureRetryClient,
	fetchWithRetry,
	generateIdempotencyKey,
	IDEMPOTENCY_HEADER,
	isIdempotentMethod,
	isRetryableStatus,
	parseRetryAfter,
	type RetryLogEntry,
	type RetryLogger,
	RETRYABLE_STATUS_CODES,
	RequestQueue,
	setRetryLogger,
} from '../retryClient';

function jsonResponse(
	status: number,
	body: unknown = {},
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

beforeEach(() => {
	_resetRetryClient();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	_resetRetryClient();
});

// ---------------------------------------------------------------------------
// Deterministic retryable status codes
// ---------------------------------------------------------------------------

describe('RETRYABLE_STATUS_CODES', () => {
	it('defines the canonical deterministic set exactly once', () => {
		expect(RETRYABLE_STATUS_CODES).toEqual([408, 425, 429, 500, 502, 503, 504]);
	});

	it('is frozen so callers cannot diverge from the shared definition', () => {
		expect(Object.isFrozen(RETRYABLE_STATUS_CODES)).toBe(true);
		expect(() => {
			(RETRYABLE_STATUS_CODES as number[]).push(418);
		}).toThrow();
	});
});

describe('isRetryableStatus', () => {
	it.each([
		408, 425, 429, 500, 502, 503, 504,
	])('returns true for %d', (status) => {
		expect(isRetryableStatus(status)).toBe(true);
	});

	it.each([
		200, 201, 301, 400, 401, 403, 404, 409, 413, 422, 418,
	])('returns false for non-retryable %d', (status) => {
		expect(isRetryableStatus(status)).toBe(false);
	});

	it('honours a per-client override set', () => {
		expect(isRetryableStatus(409, [409, 503])).toBe(true);
		expect(isRetryableStatus(429, [409, 503])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Backoff calculation (pure)
// ---------------------------------------------------------------------------

describe('calculateBackoffDelayMs', () => {
	it('grows exponentially from the base with jitter: none', () => {
		const config = {
			baseDelayMs: 1000,
			factor: 2,
			maxDelayMs: 10_000,
			jitter: 'none' as const,
		};
		expect(calculateBackoffDelayMs(0, config)).toBe(1000);
		expect(calculateBackoffDelayMs(1, config)).toBe(2000);
		expect(calculateBackoffDelayMs(2, config)).toBe(4000);
	});

	it('caps the delay at maxDelayMs', () => {
		const config = {
			baseDelayMs: 1000,
			factor: 2,
			maxDelayMs: 3000,
			jitter: 'none' as const,
		};
		expect(calculateBackoffDelayMs(2, config)).toBe(3000);
		expect(calculateBackoffDelayMs(10, config)).toBe(3000);
	});

	it('uses default config when none is passed', () => {
		// Default jitter is 'full' (random) — assert the deterministic pieces
		// with jitter disabled, then the range for a bare no-args call.
		expect(calculateBackoffDelayMs(0, { jitter: 'none' }, null)).toBe(1000);
		expect(calculateBackoffDelayMs(1, { jitter: 'none' }, null)).toBe(2000);
		const delay = calculateBackoffDelayMs(0);
		expect(delay).toBeGreaterThanOrEqual(0);
		expect(delay).toBeLessThan(1000);
	});

	it('full jitter: delay is uniform in [0, raw)', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.25);
		expect(
			calculateBackoffDelayMs(1, {
				baseDelayMs: 1000,
				factor: 2,
				jitter: 'full',
			}),
		).toBe(500);
		vi.spyOn(Math, 'random').mockReturnValue(0.99);
		expect(
			calculateBackoffDelayMs(1, {
				baseDelayMs: 1000,
				factor: 2,
				jitter: 'full',
			}),
		).toBe(1980);
	});

	it('equal jitter: delay is uniform in [raw/2, raw]', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		expect(
			calculateBackoffDelayMs(1, {
				baseDelayMs: 1000,
				factor: 2,
				jitter: 'equal',
			}),
		).toBe(1000);
		vi.spyOn(Math, 'random').mockReturnValue(1);
		expect(
			calculateBackoffDelayMs(1, {
				baseDelayMs: 1000,
				factor: 2,
				jitter: 'equal',
			}),
		).toBe(2000);
	});

	it('a Retry-After hint overrides the computed delay (no jitter)', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.999);
		expect(
			calculateBackoffDelayMs(0, { baseDelayMs: 1000, jitter: 'full' }, 5),
		).toBe(5000);
	});

	it('ignores a non-positive Retry-After hint', () => {
		expect(
			calculateBackoffDelayMs(0, { baseDelayMs: 1000, jitter: 'none' }, 0),
		).toBe(1000);
		expect(
			calculateBackoffDelayMs(0, { baseDelayMs: 1000, jitter: 'none' }, -3),
		).toBe(1000);
	});
});

describe('parseRetryAfter', () => {
	it('parses delay-seconds', () => {
		expect(parseRetryAfter('120')).toBe(120);
		expect(parseRetryAfter('0.5')).toBe(0.5);
	});

	it('parses HTTP-date and floors to at least 1s', () => {
		vi.setSystemTime(new Date('2026-07-31T09:00:00Z'));
		const future = new Date('2026-07-31T09:02:00Z').toUTCString();
		expect(parseRetryAfter(future)).toBe(120);
	});

	it('returns null for absent / invalid values', () => {
		expect(parseRetryAfter(null)).toBeNull();
		expect(parseRetryAfter('')).toBeNull();
		expect(parseRetryAfter('soon')).toBeNull();
		expect(parseRetryAfter('0')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// fetchWithRetry
// ---------------------------------------------------------------------------

describe('fetchWithRetry', () => {
	it('returns a successful response on the first attempt', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { ok: true }));
		vi.stubGlobal('fetch', fetchMock);

		const res = await fetchWithRetry(
			'https://jira.example/rest/api/2/issue/X',
			{
				headers: { Authorization: 'Bearer tok' },
			},
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('retries retryable statuses with exponential backoff then succeeds', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(503))
			.mockResolvedValueOnce(jsonResponse(503))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		vi.stubGlobal('fetch', fetchMock);

		const config = {
			maxRetries: 3,
			baseDelayMs: 1000,
			factor: 2,
			jitter: 'none' as const,
		};
		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			undefined,
			config,
		);
		await vi.advanceTimersByTimeAsync(1000); // attempt 1 → retry 1
		await vi.advanceTimersByTimeAsync(2000); // attempt 2 → retry 2
		await vi.advanceTimersByTimeAsync(4000); // attempt 3 → 200
		const res = await promise;

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('returns the last retryable response once retries are exhausted', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(503, { error: 'boom' }));
		vi.stubGlobal('fetch', fetchMock);

		const config = {
			maxRetries: 2,
			baseDelayMs: 100,
			factor: 2,
			jitter: 'none' as const,
		};
		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			undefined,
			config,
		);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(200);
		const res = await promise;

		expect(res.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
	});

	it('honours Retry-After on 429 instead of the computed backoff', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '5' }))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		vi.stubGlobal('fetch', fetchMock);

		const config = {
			maxRetries: 1,
			baseDelayMs: 1000,
			jitter: 'none' as const,
		};
		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			undefined,
			config,
		);
		// Server said 5s — a 1s (or 2s, 4s…) computed delay must NOT fire the retry.
		await vi.advanceTimersByTimeAsync(4000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		const res = await promise;

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('does not retry deterministic client errors', async () => {
		for (const status of [400, 401, 403, 404, 422]) {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status));
			vi.stubGlobal('fetch', fetchMock);

			const res = await fetchWithRetry(
				'https://jira.example/rest/api/2/myself',
				undefined,
				{
					maxRetries: 3,
				},
			);

			expect(res.status).toBe(status);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});

	it('supports a per-client retryable-status override', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(409))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		vi.stubGlobal('fetch', fetchMock);

		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/issue/X',
			undefined,
			{
				retryableStatuses: [409],
				maxRetries: 1,
				baseDelayMs: 100,
				jitter: 'none' as const,
			},
		);
		await vi.advanceTimersByTimeAsync(100);
		const res = await promise;

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('retries network failures when retryOnNetworkError is on', async () => {
		const networkError = new TypeError('Failed to fetch');
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		vi.stubGlobal('fetch', fetchMock);

		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			undefined,
			{
				maxRetries: 1,
				baseDelayMs: 100,
				jitter: 'none' as const,
			},
		);
		await vi.advanceTimersByTimeAsync(100);
		const res = await promise;

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('rethrows the underlying error when network retries are exhausted', async () => {
		const networkError = new TypeError('Failed to fetch');
		const fetchMock = vi.fn().mockRejectedValue(networkError);
		vi.stubGlobal('fetch', fetchMock);

		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			undefined,
			{
				maxRetries: 2,
				baseDelayMs: 100,
				jitter: 'none' as const,
			},
		);
		// Attach the rejection handler before the timers run so the final
		// rejection is never observed without a listener.
		const rejection = expect(promise).rejects.toBe(networkError);
		await vi.advanceTimersByTimeAsync(100); // attempt 1 → retry 1
		await vi.advanceTimersByTimeAsync(200); // attempt 2 → retry 2 (exponential)
		await rejection;
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('does not retry network failures when retryOnNetworkError is off', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new TypeError('Failed to fetch'));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			fetchWithRetry('https://jira.example/rest/api/2/myself', undefined, {
				retryOnNetworkError: false,
				maxRetries: 3,
			}),
		).rejects.toThrow('Failed to fetch');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('throws AbortError immediately when already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			fetchWithRetry('https://jira.example/rest/api/2/myself', {
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('aborts mid-backoff and never retries after an abort', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
		vi.stubGlobal('fetch', fetchMock);

		const controller = new AbortController();
		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			{ signal: controller.signal },
			{ maxRetries: 3, baseDelayMs: 1000, jitter: 'none' as const },
		);

		await vi.advanceTimersByTimeAsync(500);
		controller.abort();
		await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
		await vi.runAllTimersAsync();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('propagates an AbortError rejection from fetch without retrying', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			fetchWithRetry('https://jira.example/rest/api/2/myself', undefined, {
				maxRetries: 3,
			}),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Request queue
// ---------------------------------------------------------------------------

describe('RequestQueue', () => {
	/** Flush the microtask chain (fn continuation → run() finally → next task start). */
	async function flushMicrotasks(): Promise<void> {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	}

	it('runs a single task immediately', async () => {
		const queue = new RequestQueue(2);
		let ran = false;
		await queue.run(async () => {
			ran = true;
		});
		expect(ran).toBe(true);
		expect(queue.inFlight).toBe(0);
		expect(queue.pending).toBe(0);
	});

	it('never exceeds maxConcurrent in-flight tasks', async () => {
		const queue = new RequestQueue(2);
		let inFlight = 0;
		let peak = 0;
		const blockers: Array<() => void> = [];

		const tasks = Array.from({ length: 5 }, () =>
			queue.run(async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise<void>((resolve) => {
					blockers.push(resolve);
				});
				inFlight--;
			}),
		);

		// Let the first two tasks start and block.
		await flushMicrotasks();
		expect(inFlight).toBe(2);
		expect(queue.pending).toBe(3);

		// Release the first task; the queue must admit the next one so the
		// in-flight count stays at the cap.
		blockers.shift()?.();
		await flushMicrotasks();
		expect(inFlight).toBe(2);
		expect(queue.pending).toBe(2);

		// Drain: every release lets a queued task start and block again.
		let guard = 0;
		while ((queue.inFlight > 0 || queue.pending > 0) && guard++ < 20) {
			blockers.shift()?.();
			await flushMicrotasks();
		}

		await Promise.all(tasks);
		expect(peak).toBe(2);
		expect(inFlight).toBe(0);
		expect(queue.pending).toBe(0);
	});

	it('rejects an invalid concurrency limit', () => {
		expect(() => new RequestQueue(0)).toThrow(RangeError);
		expect(() => new RequestQueue(1.5)).toThrow(RangeError);
		expect(() => new RequestQueue(-1)).toThrow(RangeError);
	});
});

// ---------------------------------------------------------------------------
// Config plumbing
// ---------------------------------------------------------------------------

describe('configureRetryClient', () => {
	it('sets module defaults used by later calls', async () => {
		configureRetryClient({ maxRetries: 1, baseDelayMs: 100, jitter: 'none' });

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(503))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		vi.stubGlobal('fetch', fetchMock);

		const promise = fetchWithRetry('https://jira.example/rest/api/2/myself');
		await vi.advanceTimersByTimeAsync(100);
		const res = await promise;

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('warns and ignores late configuration after the first call', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200)));
		await fetchWithRetry('https://jira.example/rest/api/2/myself');

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		configureRetryClient({ maxRetries: 9 });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
		warn.mockRestore();
	});

	it('per-call config wins over configured defaults', async () => {
		configureRetryClient({ maxRetries: 5, baseDelayMs: 500, jitter: 'none' });

		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
		vi.stubGlobal('fetch', fetchMock);

		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			undefined,
			{
				maxRetries: 0,
			},
		);
		const res = await promise;

		expect(res.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(1); // no retries allowed per-call
	});

	it('validates nonsense configuration eagerly', () => {
		expect(() => configureRetryClient({ maxRetries: -1 })).toThrow(RangeError);
		expect(() => configureRetryClient({ baseDelayMs: -5 })).toThrow(RangeError);
		expect(() =>
			configureRetryClient({ maxDelayMs: 10, baseDelayMs: 1000 }),
		).toThrow(RangeError);
		expect(() => configureRetryClient({ factor: 0.5 })).toThrow(RangeError);
		expect(() => configureRetryClient({ maxConcurrent: 0 })).toThrow(
			RangeError,
		);
	});
});

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

describe('structured logging', () => {
	let logEntries: RetryLogEntry[];

	const captureLogger: RetryLogger = {
		info(entry) {
			logEntries.push(entry);
		},
		warn(entry) {
			logEntries.push(entry);
		},
	};

	beforeEach(() => {
		logEntries = [];
		setRetryLogger(captureLogger);
	});

	afterEach(() => {
		_resetRetryLogger();
	});

	it('emits queued → attempt → success phases for a clean call', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })),
		);

		await fetchWithRetry('https://jira.example/rest/api/2/myself', undefined, {
			maxRetries: 0,
		});

		const phases = logEntries.map((e) => e.phase);
		expect(phases).toEqual(['queued', 'attempt', 'success']);
		expect(logEntries[2].status).toBe(200);
		expect(logEntries[2].totalAttempts).toBe(1);
	});

	it('emits retryable and succeeds after transient failures', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(503))
			.mockResolvedValueOnce(jsonResponse(429))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		vi.stubGlobal('fetch', fetchMock);

		const config = {
			maxRetries: 3,
			baseDelayMs: 100,
			jitter: 'none' as const,
		};
		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			undefined,
			config,
		);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(200);
		const res = await promise;

		expect(res.status).toBe(200);
		const phases = logEntries.map((e) => e.phase);
		expect(phases).toContain('retryable');
		expect(phases).toContain('success');
		const retryableEntries = logEntries.filter((e) => e.phase === 'retryable');
		expect(retryableEntries[0].status).toBe(503);
		expect(retryableEntries[1].status).toBe(429);
	});

	it('emits exhausted warning when retries run out for a retryable status', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
		vi.stubGlobal('fetch', fetchMock);

		const config = {
			maxRetries: 2,
			baseDelayMs: 100,
			jitter: 'none' as const,
		};
		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			undefined,
			config,
		);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(200);
		const res = await promise;

		expect(res.status).toBe(503);
		const exhausted = logEntries.find((e) => e.phase === 'exhausted');
		expect(exhausted).toBeDefined();
		expect(exhausted!.status).toBe(503);
	});

	it('emits non-retryable and returns immediately for client errors', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404)));

		const res = await fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			undefined,
			{ maxRetries: 3 },
		);

		expect(res.status).toBe(404);
		expect(logEntries.map((e) => e.phase)).toEqual([
			'queued',
			'attempt',
			'non-retryable',
		]);
	});

	it('emits network-retry then exhausted on persistent network failure', async () => {
		const networkError = new TypeError('Failed to fetch');
		const fetchMock = vi.fn().mockRejectedValue(networkError);
		vi.stubGlobal('fetch', fetchMock);

		const config = {
			maxRetries: 2,
			baseDelayMs: 100,
			jitter: 'none' as const,
		};
		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			undefined,
			config,
		);

		// Attach the reject handler BEFORE advancing timers so Vitest
		// never sees this rejection as unhandled while fake timers run.
		const handled = promise.then(
			() => {
				throw new Error('expected fetchWithRetry to reject');
			},
			(err: unknown) => {
				expect(err).toBe(networkError);
			},
		);

		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(200);
		await handled;

		const phases = logEntries.map((e) => e.phase);
		expect(phases).toContain('network-retry');
		expect(phases).toContain('exhausted');
		const netRetry = logEntries.find((e) => e.phase === 'network-retry');
		expect(netRetry!.error).toContain('Failed to fetch');
		expect(netRetry!.delayMs).toBeGreaterThan(0);
	});

	it('emits aborted on mid-backoff abort', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
		vi.stubGlobal('fetch', fetchMock);

		const controller = new AbortController();
		const promise = fetchWithRetry(
			'https://jira.example/rest/api/2/myself',
			{ signal: controller.signal },
			{ maxRetries: 3, baseDelayMs: 1000, jitter: 'none' as const },
		);

		await vi.advanceTimersByTimeAsync(500);
		controller.abort();
		await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

		expect(logEntries.map((e) => e.phase)).toContain('aborted');
	});
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
	describe('isIdempotentMethod', () => {
		it.each([
			'POST',
			'PUT',
			'PATCH',
			'DELETE',
		] as const)('returns true for %s', (method) => {
			expect(isIdempotentMethod(method)).toBe(true);
			expect(isIdempotentMethod(method.toLowerCase())).toBe(true);
		});

		it.each([
			'GET',
			'HEAD',
			'OPTIONS',
		] as const)('returns false for safe method %s', (method) => {
			expect(isIdempotentMethod(method)).toBe(false);
		});
	});

	describe('generateIdempotencyKey', () => {
		it('returns a non-empty string', () => {
			const key = generateIdempotencyKey();
			expect(typeof key).toBe('string');
			expect(key.length).toBeGreaterThan(0);
		});

		it('produces unique keys across successive calls', () => {
			const keys = new Set(
				Array.from({ length: 100 }, () => generateIdempotencyKey()),
			);
			expect(keys.size).toBe(100);
		});
	});

	describe('fetchWithRetry idempotency-key injection', () => {
		it('injects an Idempotency-Key header for POST requests', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(jsonResponse(200, { ok: true }));
			vi.stubGlobal('fetch', fetchMock);

			await fetchWithRetry(
				'https://jira.example/rest/api/2/issue',
				{ method: 'POST', body: '{}' },
				{ maxRetries: 0 },
			);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
			expect(headers.has(IDEMPOTENCY_HEADER)).toBe(true);
			const key = headers.get(IDEMPOTENCY_HEADER);
			expect(key).toBeTruthy();
			expect(key!.length).toBeGreaterThan(0);
		});

		it('reuses the same key across retries for mutating requests', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(jsonResponse(503))
				.mockResolvedValueOnce(jsonResponse(503))
				.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
			vi.stubGlobal('fetch', fetchMock);

			const config = {
				maxRetries: 3,
				baseDelayMs: 100,
				jitter: 'none' as const,
			};
			const promise = fetchWithRetry(
				'https://jira.example/rest/api/2/issue',
				{ method: 'POST', body: '{}' },
				config,
			);
			await vi.advanceTimersByTimeAsync(100);
			await vi.advanceTimersByTimeAsync(200);
			await promise;

			expect(fetchMock).toHaveBeenCalledTimes(3);
			const keys = fetchMock.mock.calls.map((call: unknown[]) => {
				const h = (call[1] as { headers: Headers }).headers;
				return h.get(IDEMPOTENCY_HEADER);
			});
			expect(new Set(keys).size).toBe(1);
			expect(keys[0]).toBeTruthy();
		});

		it('does not inject an Idempotency-Key for GET requests', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(jsonResponse(200, { ok: true }));
			vi.stubGlobal('fetch', fetchMock);

			await fetchWithRetry(
				'https://jira.example/rest/api/2/myself',
				undefined,
				{
					maxRetries: 0,
				},
			);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const headers = fetchMock.mock.calls[0][1]?.headers as
				| Headers
				| undefined;
			expect(headers?.has(IDEMPOTENCY_HEADER) ?? false).toBe(false);
		});

		it('preserves a caller-supplied Idempotency-Key across retries', async () => {
			const callerKey = 'my-custom-key-123';
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(jsonResponse(503))
				.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
			vi.stubGlobal('fetch', fetchMock);

			const headers = new Headers();
			headers.set(IDEMPOTENCY_HEADER, callerKey);

			const config = {
				maxRetries: 3,
				baseDelayMs: 100,
				jitter: 'none' as const,
			};
			const promise = fetchWithRetry(
				'https://jira.example/rest/api/2/issue',
				{ method: 'POST', body: '{}', headers },
				config,
			);
			await vi.advanceTimersByTimeAsync(100);
			await promise;

			expect(fetchMock).toHaveBeenCalledTimes(2);
			const keys = fetchMock.mock.calls.map((call: unknown[]) => {
				const h = (call[1] as { headers: Headers }).headers;
				return h.get(IDEMPOTENCY_HEADER);
			});
			expect(new Set(keys).size).toBe(1);
			expect(keys[0]).toBe(callerKey);
		});

		it('includes idempotencyKey in structured log entries for mutating requests', async () => {
			const logEntries: RetryLogEntry[] = [];
			setRetryLogger({
				info(e) {
					logEntries.push(e);
				},
				warn(e) {
					logEntries.push(e);
				},
			});

			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(jsonResponse(503))
				.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
			vi.stubGlobal('fetch', fetchMock);

			const config = {
				maxRetries: 2,
				baseDelayMs: 100,
				jitter: 'none' as const,
			};
			const promise = fetchWithRetry(
				'https://jira.example/rest/api/2/issue',
				{ method: 'PUT', body: '{}' },
				config,
			);
			await vi.advanceTimersByTimeAsync(100);
			await promise;

			_resetRetryLogger();

			const keys = logEntries
				.map((e) => e.idempotencyKey)
				.filter((k): k is string => k !== undefined);
			expect(new Set(keys).size).toBe(1);
			expect(keys[0]).toBeTruthy();
		});
	});
});
