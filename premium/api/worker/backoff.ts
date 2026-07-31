/**
 * Exponential backoff and retry primitives (ADA-710).
 *
 * Shared by the batch worker and the CLI so every retry site in the premium
 * API follows one policy: exponential growth, an upper cap so a long outage
 * never sleeps forever, and full jitter so concurrent workers do not retry in
 * lockstep. Pure functions — no timers except `sleep`, so tests can use fake
 * timers.
 */

export interface BackoffOptions {
	/** Delay before the first retry, in milliseconds. */
	initialDelayMs: number;
	/** Upper bound for the delay, in milliseconds. */
	maxDelayMs: number;
	/** Multiplicative growth factor between attempts. */
	factor: number;
	/** Apply full jitter: delay is uniform in [0, base] (defaults to true). */
	jitter?: boolean;
}

/**
 * Compute the backoff delay for a given retry attempt (0-based).
 *
 * Attempt 0 is the first retry: it waits `initialDelayMs` (or less with
 * jitter). Each further attempt multiplies the base by `factor` until
 * `maxDelayMs` is reached, then the cap applies forever.
 */
export function backoffDelay(attempt: number, options: BackoffOptions): number {
	const base = Math.min(
		options.initialDelayMs * options.factor ** Math.max(0, attempt),
		options.maxDelayMs,
	);
	if (options.jitter === false) {
		return base;
	}
	return Math.floor(Math.random() * base);
}

/** Resolve after `ms` milliseconds. Uses `setTimeout` so fake timers work. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export interface RetryOptions {
	/** Total number of attempts, or `Infinity` to retry forever. */
	attempts: number;
	/** Backoff policy applied between attempts. */
	backoff: BackoffOptions;
	/** Called after a failed attempt with the error and the 0-based attempt. */
	onRetry?: (error: unknown, attempt: number) => void;
	/**
	 * Optional predicate deciding which failures are retryable. Defaults to
	 * retrying everything.
	 */
	isRetryable?: (error: unknown) => boolean;
}

/**
 * Run `fn`, retrying failures with exponential backoff.
 *
 * `attempt` is 0-based: the first call is attempt 0, the first retry is
 * attempt 1, and its delay is `backoffDelay(1, backoff)`.
 *
 * @throws The last error once `attempts` are exhausted (or immediately for a
 *   non-retryable failure).
 */
export async function withRetries<T>(
	fn: () => Promise<T>,
	options: RetryOptions,
): Promise<T> {
	const { attempts, backoff, onRetry, isRetryable } = options;
	let attempt = 0;
	for (;;) {
		try {
			return await fn();
		} catch (error) {
			if (!isRetryable || isRetryable(error)) {
				const lastAttempt = attempt + 1 >= attempts;
				if (lastAttempt) {
					throw error;
				}
				onRetry?.(error, attempt + 1);
				await sleep(backoffDelay(attempt + 1, backoff));
			} else {
				throw error;
			}
		}
		attempt += 1;
	}
}
