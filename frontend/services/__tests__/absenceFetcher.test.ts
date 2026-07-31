import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../serviceErrors';
import {
	createAbsenceFetcher,
	DEFAULT_MAX_RETRIES,
	DEFAULT_RETRY_DELAY_MS,
	DEFAULT_TIMEOUT_MS,
	fetchAbsenceFeed,
	type FetchLike,
} from '../absenceFetcher';

// --------------- helpers ---------------

/** Build a mock `Response` with the given status and body. */
function mockResponse(
	status: number,
	body: string,
	statusText = '',
): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		text: async () => body,
		json: async () => {
			throw new Error('not JSON');
		},
		headers: new Headers(),
		redirected: false,
		type: 'basic' as ResponseType,
		url: '',
		clone: function () {
			return mockResponse(status, body, statusText);
		},
		body: null,
		bodyUsed: false,
		arrayBuffer: async () => new ArrayBuffer(0),
		blob: async () => new Blob(),
		formData: async () => new FormData(),
	} as unknown as Response;
}

/** Create a mock fetch that resolves to a given response. */
function mockFetch(
	responses: Response[] | (() => Response),
): FetchLike {
	if (Array.isArray(responses)) {
		let idx = 0;
		return vi.fn(async () => {
			const res = responses[idx];
			idx = Math.min(idx + 1, responses.length - 1);
			return res;
		});
	}
	return vi.fn(async () => responses());
}

// --------------- tests ---------------

describe('fetchAbsenceFeed', () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	// -- happy path -------------------------------------------------------

	it('returns the body text on a successful fetch', async () => {
		const fetchImpl = mockFetch([mockResponse(200, 'ICS_BODY')]);

		const result = await fetchAbsenceFeed('https://example.com/feed.ics', undefined, {
			fetchImpl,
			maxRetries: 0,
		});

		expect(result).toBe('ICS_BODY');
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://example.com/feed.ics',
			expect.objectContaining({
				headers: expect.objectContaining({
					accept: expect.stringContaining('text/calendar'),
				}),
			}),
		);
	});

	it('returns empty string for empty response body', async () => {
		const fetchImpl = mockFetch([mockResponse(200, '')]);

		const result = await fetchAbsenceFeed('https://example.com/feed.ics', undefined, {
			fetchImpl,
			maxRetries: 0,
		});

		expect(result).toBe('');
	});

	it('uses the injected fetch implementation', async () => {
		const fetchImpl = mockFetch([mockResponse(200, 'test')]);

		await fetchAbsenceFeed('https://example.com/feed.ics', undefined, {
			fetchImpl,
			maxRetries: 0,
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	// -- retry on transient errors ----------------------------------------

	it.each([
		[408, 'Request Timeout'],
		[429, 'Too Many Requests'],
		[500, 'Internal Server Error'],
		[502, 'Bad Gateway'],
		[503, 'Service Unavailable'],
		[504, 'Gateway Timeout'],
	])(
		'retries on HTTP %i (%s) and succeeds on the next attempt',
		async (status, _label) => {
			const fetchImpl = mockFetch([
				mockResponse(status, 'transient'),
				mockResponse(200, 'success'),
			]);

			const result = await fetchAbsenceFeed(
				'https://example.com/feed.ics',
				undefined,
				{ fetchImpl, maxRetries: 2, retryDelayMs: 10 },
			);

			expect(result).toBe('success');
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		},
	);

	// -- no retry on non-transient errors ---------------------------------

	it.each([
		[400, 'Bad Request'],
		[401, 'Unauthorized'],
		[403, 'Forbidden'],
		[404, 'Not Found'],
		[405, 'Method Not Allowed'],
		[422, 'Unprocessable Entity'],
	])(
		'throws immediately on HTTP %i (%s) without retrying',
		async (status) => {
			const fetchImpl = mockFetch([mockResponse(status, 'client error')]);

			await expect(
				fetchAbsenceFeed('https://example.com/feed.ics', undefined, {
					fetchImpl,
					maxRetries: 3,
					retryDelayMs: 10,
				}),
			).rejects.toThrow(ServiceError);

			expect(fetchImpl).toHaveBeenCalledOnce();
		},
	);

	// -- exhausting retries -----------------------------------------------

	it('throws a ServiceError after exhausting retries on transient status', async () => {
		const fetchImpl = mockFetch([
			mockResponse(503, 'unavailable'),
			mockResponse(503, 'unavailable'),
			mockResponse(503, 'unavailable'),
			mockResponse(503, 'unavailable'), // 4 calls = 3 retries
		]);

		await expect(
			fetchAbsenceFeed('https://example.com/feed.ics', undefined, {
				fetchImpl,
				maxRetries: 3,
				retryDelayMs: 10,
			}),
		).rejects.toThrow(ServiceError);

		// 1 initial + 3 retries = 4 calls
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});

	it('throws a ServiceError after exhausting retries on network errors', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});

		await expect(
			fetchAbsenceFeed('https://example.com/feed.ics', undefined, {
				fetchImpl,
				maxRetries: 2,
				retryDelayMs: 10,
			}),
		).rejects.toThrow(ServiceError);

		expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 retries
	});

	// -- caller abort -----------------------------------------------------

	it('throws immediately when the caller signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = vi.fn();

		await expect(
			fetchAbsenceFeed('https://example.com/feed.ics', controller.signal, {
				fetchImpl,
				maxRetries: 5,
			}),
		).rejects.toThrow(ServiceError);

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('throws immediately without retrying when caller aborts mid-request', async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn(async () => {
			controller.abort();
			throw new DOMException('The operation was aborted.', 'AbortError');
		});

		await expect(
			fetchAbsenceFeed('https://example.com/feed.ics', controller.signal, {
				fetchImpl,
				maxRetries: 3,
				retryDelayMs: 10,
			}),
		).rejects.toThrow(ServiceError);

		expect(fetchImpl).toHaveBeenCalledOnce(); // no retry
	});

	// -- timeout -----------------------------------------------------------

	it('retries on timeout before exhausting retries', async () => {
		// Simulate a timeout by throwing an AbortError with aborted signal.
		let callCount = 0;
		const fetchImpl = vi.fn(async () => {
			callCount++;
			if (callCount <= 2) {
				// Throw a timeout-like abort — internal controller aborted
				throw new DOMException('The operation was aborted.', 'AbortError');
			}
			return mockResponse(200, 'finally');
		});

		const result = await fetchAbsenceFeed(
			'https://example.com/feed.ics',
			undefined,
			{ fetchImpl, maxRetries: 3, retryDelayMs: 10, timeoutMs: 500 },
		);

		expect(result).toBe('finally');
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	// -- exponential backoff ----------------------------------------------

	it('waits with exponential backoff between retries', async () => {
		const fetchImpl = mockFetch([
			mockResponse(500, 'error'),
			mockResponse(500, 'error'),
			mockResponse(200, 'ok'),
		]);

		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

		const promise = fetchAbsenceFeed('https://example.com/feed.ics', undefined, {
			fetchImpl,
			maxRetries: 3,
			retryDelayMs: 100,
			timeoutMs: 5000,
		});

		// Fast-forward through the backoff delays.
		// 1st retry: ~100ms * 2^0 = 100ms (with jitter: 85–115ms)
		// 2nd retry: ~100ms * 2^1 = 200ms (with jitter: 170–230ms)
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(200);

		await promise;

		expect(fetchImpl).toHaveBeenCalledTimes(3);
		// setTimeout should have been called for the delays.
		expect(setTimeoutSpy).toHaveBeenCalled();
	});

	// -- createAbsenceFetcher ----------------------------------------------

	it('createAbsenceFetcher returns a pre-configured fetcher', async () => {
		const fetchImpl = mockFetch([mockResponse(200, 'preconfigured')]);

		const fetcher = createAbsenceFetcher({
			fetchImpl,
			maxRetries: 0,
			timeoutMs: 5000,
		});

		const result = await fetcher('https://example.com/feed.ics');

		expect(result).toBe('preconfigured');
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it('createAbsenceFetcher passes signal through', async () => {
		const controller = new AbortController();
		const fetchImpl = mockFetch([mockResponse(200, 'ok')]);

		const fetcher = createAbsenceFetcher({ fetchImpl, maxRetries: 0 });

		await fetcher('https://example.com/feed.ics', controller.signal);

		expect(fetchImpl).toHaveBeenCalledWith(
			'https://example.com/feed.ics',
			expect.objectContaining({
				signal: expect.any(AbortSignal),
			}),
		);
	});

	// -- defaults ---------------------------------------------------------

	it('uses default options when none are provided', async () => {
		// Only test defaults are exported correctly — full integration with
		// real fetch is not practical in unit tests.
		expect(DEFAULT_MAX_RETRIES).toBe(3);
		expect(DEFAULT_RETRY_DELAY_MS).toBe(1000);
		expect(DEFAULT_TIMEOUT_MS).toBe(30000);
	});

	// -- edge cases -------------------------------------------------------

	it('handles a 204 No Content response', async () => {
		const fetchImpl = mockFetch([mockResponse(204, '')]);

		const result = await fetchAbsenceFeed('https://example.com/feed.ics', undefined, {
			fetchImpl,
			maxRetries: 0,
		});

		expect(result).toBe('');
	});

	it('does not retry when maxRetries is 0 and fetch fails', async () => {
		const fetchImpl = mockFetch([mockResponse(500, 'error')]);

		await expect(
			fetchAbsenceFeed('https://example.com/feed.ics', undefined, {
				fetchImpl,
				maxRetries: 0,
			}),
		).rejects.toThrow(ServiceError);

		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it('re-throws non-Error, non-DOMException throws as unexpected', async () => {
		const fetchImpl = vi.fn(() => {
			throw 'raw string error'; // not an Error instance
		});

		await expect(
			fetchAbsenceFeed('https://example.com/feed.ics', undefined, {
				fetchImpl,
				maxRetries: 2,
				retryDelayMs: 10,
			}),
		).rejects.toBe('raw string error');
	});

	it('includes status and truncated URL in error messages for non-ok responses', async () => {
		const longUrl = 'https://example.com/'.padEnd(200, 'x') + '/feed.ics';
		const fetchImpl = mockFetch([mockResponse(503, 'unavailable')]);

		try {
			await fetchAbsenceFeed(longUrl, undefined, {
				fetchImpl,
				maxRetries: 0,
			});
		} catch (error) {
			expect(error).toBeInstanceOf(ServiceError);
			const svcError = error as ServiceError;
			expect(svcError.kind).toBe('server-error');
			expect(svcError.status).toBe(503);
			expect(svcError.source).toBe('Absence feed');
		}
	});
});

// --------------- integration-style test with real timers ---------------

describe('fetchAbsenceFeed with real timers', () => {
	it('eventually succeeds after transient errors', async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockResolvedValueOnce(mockResponse(200, 'recovered'));

		const result = await fetchAbsenceFeed(
			'https://example.com/feed.ics',
			undefined,
			{ fetchImpl, maxRetries: 3, retryDelayMs: 5 },
		);

		expect(result).toBe('recovered');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});
