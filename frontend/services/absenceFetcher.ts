/**
 * Absence Data Fetcher — HTTP client wrapper for pulling absence data from
 * providers (ICS feeds, etc.) with retry logic, error handling, and response
 * mapping.
 *
 * This module is the transport layer that sits between provider configuration
 * and the ICS parser/event mapper. It handles the HTTP lifecycle — fetch,
 * timeout, retry, error classification — but does NOT parse calendar data.
 *
 * ## Architecture
 *
 *   Provider config (URL, type)
 *        ↓
 *   fetchAbsenceFeed()     ← this module
 *        ↓
 *   parseAbsenceEvents()   ← absenceService.ts
 *        ↓
 *   absenceEventMapper     ← maps dates → UserAbsenceUpsert[]
 *
 * ## Design
 *
 * - Injectable `fetch` so callers can test without network (see polarClient.ts).
 * - Retry with exponential backoff for transient failures (5xx, 429, 408).
 * - Timeout via `AbortController` — cancels the request after `timeoutMs`.
 * - All errors are typed `ServiceError` instances — never raw strings.
 * - The caller's `AbortSignal` is respected; when it fires, the fetch is
 *   aborted immediately without retries.
 *
 * @module
 */

import { fromHttpResponse, fromNetworkError } from './serviceErrors';
import type { ServiceError } from './serviceErrors';

// --- Injectable fetch type (same shape as polarClient.ts) ---

/** Injectable fetch so callers stay testable without network. */
export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

// --- Configuration ---

/** Tunable knobs for the absence feed fetcher. */
export interface AbsenceFetcherOptions {
	/**
	 * Maximum number of retry attempts on transient failures.
	 *
	 * Retries only fire for status codes in `RETRYABLE_STATUSES` (408, 429,
	 * 500–504) and for network/timeout errors. Non-retryable statuses (4xx
	 * except 408/429) throw immediately.
	 *
	 * @default 3
	 */
	maxRetries?: number;
	/**
	 * Initial backoff delay in milliseconds before the first retry.
	 * Doubles on each subsequent retry attempt.
	 *
	 * @default 1000
	 */
	retryDelayMs?: number;
	/**
	 * Maximum total wall-clock time in milliseconds before the request is
	 * aborted. An internal `AbortController` is created and combined with the
	 * caller's signal via `AbortSignal.any()` when available (fallback to
	 * manual wiring on older runtimes).
	 *
	 * @default 30000
	 */
	timeoutMs?: number;
	/**
	 * Injectable `fetch` implementation for testing.
	 *
	 * Defaults to the global `fetch` bound to the current realm.
	 */
	fetchImpl?: FetchLike;
}

/** HTTP status codes that are safe to retry (transient / upstream failures). */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
	408, 429, 500, 502, 503, 504,
]);

// --- Defaults (kept as module-level consts so callers can inspect) ---

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_TIMEOUT_MS = 30_000;

// --- Helpers ---

/** Simple sleep helper (browser-compatible — no `setTimeout` import). */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when an error is an `AbortError` triggered by the caller's signal. */
function isCallerAbort(error: unknown): boolean {
	return (
		error instanceof DOMException ||
		(error instanceof Error && error.name === 'AbortError')
	);
}

/**
 * Compose a timeout signal with the caller's optional `AbortSignal`.
 *
 * Uses `AbortSignal.any()` when available (broad support as of 2024). Falls
 * back to manual wiring so older runtimes still get correct behaviour.
 */
function createTimeoutSignal(
	callerSignal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
	const controller = new AbortController();

	// Fire the abort after timeoutMs (if not already aborted).
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	// If the caller aborts, propagate it to our internal controller.
	const onCallerAbort = () => controller.abort();
	callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

	// Wire the caller's signal so it fires our internal controller as well.
	// Use AbortSignal.any() when available — it's cleaner and forwards the
	// reason properly.
	let combined: AbortSignal;
	if (typeof AbortSignal.any === 'function') {
		const sources: AbortSignal[] = [controller.signal];
		if (callerSignal) sources.push(callerSignal);
		combined = AbortSignal.any(sources);
	} else {
		// Fallback: chain through the caller's abort reason.
		combined = controller.signal;
		if (callerSignal) {
			callerSignal.addEventListener(
				'abort',
				() => {
					try {
						controller.abort(callerSignal.reason);
					} catch {
						controller.abort();
					}
				},
				{ once: true },
			);
		}
	}

	const clear = () => {
		clearTimeout(timer);
		callerSignal?.removeEventListener('abort', onCallerAbort);
	};

	return { signal: combined, clear };
}

// --- Main export ---

/**
 * Fetch the raw text body of an absence provider feed (ICS, etc.) with retry
 * logic, timeout, and typed error handling.
 *
 * **Retry policy**
 *
 * Transient failures (HTTP 408, 429, 500–504) and network/timeout errors are
 * retried up to `maxRetries` times with exponential backoff. Non-retryable
 * HTTP errors (4xx except 408/429) throw immediately on the first attempt.
 * If the caller's `AbortSignal` fires the function aborts without retrying.
 *
 * **Timeout**
 *
 * An internal timeout (`timeoutMs`, default 30s) aborts the request if it
 * takes too long. The timeout is composed with the caller's signal so either
 * one cancels the fetch.
 *
 * @param url     - Absolute URL of the absence feed to fetch.
 * @param signal  - Optional `AbortSignal` from the caller (dashboard teardown,
 *                  user navigation, etc.). When aborted the function throws
 *                  immediately without retrying.
 * @param options - Optional overrides for max retries, backoff delay, timeout,
 *                  and injectable fetch.
 * @returns The raw response body as a string.
 * @throws {ServiceError} On any failure after exhausting retries, or
 *         immediately on non-retryable status codes.
 *
 * @example
 * ```ts
 * import { fetchAbsenceFeed } from './absenceFetcher';
 *
 * const text = await fetchAbsenceFeed(
 *   'https://calendar.example.com/team.ics',
 *   abortController.signal,
 * );
 * // Pass to parser: parseAbsenceEvents(text)
 * ```
 */
export async function fetchAbsenceFeed(
	url: string,
	signal?: AbortSignal,
	options?: AbsenceFetcherOptions,
): Promise<string> {
	const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
	const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchImpl = options?.fetchImpl ?? fetch.bind(globalThis);

	let lastError: ServiceError | undefined;
	let retries = 0;

	// Pre-check: if the caller already cancelled, bail immediately.
	if (signal?.aborted) {
		throw fromNetworkError(
			'Absence feed',
			new DOMException('The operation was aborted.', 'AbortError'),
		);
	}

	for (retries = 0; retries <= maxRetries; retries++) {
		const { signal: timeoutSignal, clear } = createTimeoutSignal(
			signal,
			timeoutMs,
		);

		try {
			const res = await fetchImpl(url, {
				signal: timeoutSignal,
				// ICS feeds are plain text — no JSON. We accept any text/*
				// content type but don't enforce, because broken servers often
				// serve ICS as application/octet-stream.
				headers: { accept: 'text/calendar, text/plain, */*' },
			});

			if (!res.ok) {
				// Build a typed ServiceError from the HTTP response.
				const error = fromHttpResponse(
					'Absence feed',
					res.status,
					url.length > 60 ? `${url.slice(0, 57)}...` : url,
				);

				// Non-retryable status → throw immediately.
				if (!RETRYABLE_STATUSES.has(res.status)) {
					throw error;
				}

				lastError = error;
				// Fall through to retry logic below.
			} else {
				const text = await res.text();
				return text;
			}
		} catch (error: unknown) {
			// If the caller cancelled, surface it immediately — no retry.
			if (signal?.aborted) {
				const abortError =
					error instanceof DOMException || error instanceof Error
						? error
						: new DOMException('The operation was aborted.', 'AbortError');
				throw fromNetworkError('Absence feed', abortError);
			}

			// Timeout / abort from our internal controller is retryable.
			if (isCallerAbort(error) && timeoutSignal.aborted && !signal?.aborted) {
				lastError = fromNetworkError(
					'Absence feed',
					new DOMException(
						`Request timed out after ${timeoutMs}ms`,
						'TimeoutError',
					),
				);
				// Fall through to retry.
			} else if (error instanceof Error && !(error as { status?: number }).status) {
				// Network-level error (DNS, connection refused, etc.) — retryable.
				lastError = fromNetworkError('Absence feed', error);
			} else if (
				!(error instanceof DOMException) &&
				!(error instanceof Error && error.name === 'AbortError')
			) {
				// Re-throw unexpected errors (programmer mistakes).
				throw error;
			}
			// For DOMException/AbortError that isn't our timeout and isn't the
			// caller's cancel, fall through to retry.
		} finally {
			clear();
		}

		// If we exhausted retries, throw the last captured error.
		if (retries >= maxRetries) {
			throw (
				lastError ??
				fromNetworkError(
					'Absence feed',
					new Error('Fetch failed after exhausting retries'),
				)
			);
		}

		// Exponential backoff: delay * 2^retries, with jitter.
		const jitter = Math.random() * 0.3 + 0.85; // 85%–115% of base delay
		const wait = retryDelayMs * 2 ** retries * jitter;
		await delay(Math.round(wait));
	}

	// TypeScript needs this even though the loop always throws or returns.
	throw (
		lastError ??
		fromNetworkError(
			'Absence feed',
			new Error('Fetch failed after exhausting retries'),
		)
	);
}

// --- Config-builder (convenience) ---

/**
 * Create a pre-configured fetcher bound to specific options, so callers that
 * always use the same retry/timeout config don't have to thread options
 * through every call-site.
 *
 * @example
 * ```ts
 * const fetcher = createAbsenceFetcher({ maxRetries: 5, timeoutMs: 15_000 });
 * const text = await fetcher('https://cal.example.com/feed.ics', signal);
 * ```
 */
export function createAbsenceFetcher(
	options: AbsenceFetcherOptions,
): (url: string, signal?: AbortSignal) => Promise<string> {
	return (url, signal) => fetchAbsenceFeed(url, signal, options);
}
