/**
 * Retry policy and error handling for transient (network / infrastructure)
 * failures during execution. ADA-739.
 *
 * A {@link RetryPolicy} describes when and how an operation that failed
 * should be re-run: how many attempts, how long to wait between attempts
 * (exponential backoff, optionally with jitter), and which failures are
 * considered transient in the first place.
 *
 * Handlers that talk to the network should throw {@link RetryPolicyError}
 * (or return a failed execution result with `error.retryable === true`) for
 * failures worth re-running. Anything else is treated as a permanent failure
 * and surfaced as-is.
 */

export const RETRYABLE_HTTP_STATUSES: readonly number[] = Object.freeze([
	408, // Request Timeout
	425, // Too Early
	429, // Too Many Requests
	500, // Internal Server Error
	502, // Bad Gateway
	503, // Service Unavailable
	504, // Gateway Timeout
]);

export type BackoffJitter = 'none' | 'full' | 'equal';

export interface RetryPolicy {
	/** Total executions of the operation, including the initial attempt (>= 1). */
	maxAttempts: number;
	/** Delay before the first retry, in milliseconds. */
	baseDelayMs: number;
	/** Cap on the computed backoff delay, in milliseconds. */
	maxDelayMs: number;
	/** Backoff multiplier applied after each failed attempt (>= 1). */
	factor: number;
	/** Jitter applied to backoff delays to avoid thundering herds. */
	jitter: BackoffJitter;
	/** HTTP status codes treated as transient and therefore retryable. */
	retryableStatuses: readonly number[];
	/** Whether transient network errors (e.g. `fetch` rejections) are retried. */
	retryOnNetworkError: boolean;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
	maxAttempts: 3,
	baseDelayMs: 1_000,
	maxDelayMs: 30_000,
	factor: 2,
	jitter: 'full',
	retryableStatuses: RETRYABLE_HTTP_STATUSES,
	retryOnNetworkError: true,
});

/**
 * Merge a (possibly partial) override into the default policy, validating the
 * result. Pass `null`/`undefined` to get the default policy unchanged.
 */
export function resolveRetryPolicy(
	override?: Partial<RetryPolicy> | null,
): RetryPolicy {
	const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...override };
	const assert = (condition: unknown, message: string): void => {
		if (!condition) {
			throw new RangeError(`Invalid retry policy: ${message}`);
		}
	};
	assert(
		Number.isInteger(policy.maxAttempts) && policy.maxAttempts >= 1,
		'maxAttempts must be an integer >= 1',
	);
	assert(
		Number.isFinite(policy.baseDelayMs) && policy.baseDelayMs >= 0,
		'baseDelayMs must be a finite number >= 0',
	);
	assert(
		Number.isFinite(policy.maxDelayMs) && policy.maxDelayMs >= 0,
		'maxDelayMs must be a finite number >= 0',
	);
	assert(
		policy.maxDelayMs >= policy.baseDelayMs,
		'maxDelayMs must be >= baseDelayMs',
	);
	assert(
		Number.isFinite(policy.factor) && policy.factor >= 1,
		'factor must be a finite number >= 1',
	);
	assert(
		policy.jitter === 'none' ||
			policy.jitter === 'full' ||
			policy.jitter === 'equal',
		"jitter must be 'none', 'full', or 'equal'",
	);
	assert(
		Array.isArray(policy.retryableStatuses),
		'retryableStatuses must be an array of HTTP status codes',
	);
	assert(
		typeof policy.retryOnNetworkError === 'boolean',
		'retryOnNetworkError must be a boolean',
	);
	return policy;
}

/** True when the HTTP status code is considered transient by the policy. */
export function isRetryableHttpStatus(
	status: number,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
	return policy.retryableStatuses.includes(status);
}

/**
 * Compute the delay before retrying a given attempt.
 *
 * `attempt` is zero-based: the first retry (after the initial attempt failed)
 * has attempt 0 and therefore waits `baseDelayMs`.
 *
 * `retryAfterHintMs`, when provided, is honored as-is (no jitter) — callers
 * that know an exact delay (e.g. a `Retry-After` header) should pass it.
 */
export function calculateBackoffDelayMs(
	attempt: number,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
	retryAfterHintMs: number | null = null,
): number {
	if (
		retryAfterHintMs !== null &&
		Number.isFinite(retryAfterHintMs) &&
		retryAfterHintMs > 0
	) {
		return Math.round(retryAfterHintMs);
	}
	const raw = Math.min(
		policy.baseDelayMs * policy.factor ** attempt,
		policy.maxDelayMs,
	);
	switch (policy.jitter) {
		case 'none':
			return raw;
		case 'equal': {
			const half = raw / 2;
			return Math.round(half + Math.random() * half);
		}
		// 'full' jitter is the default behavior.
		default:
			return Math.round(Math.random() * raw);
	}
}

/**
 * A typed error that carries retry semantics. Throw this from a handler for
 * failures you know how to classify:
 *
 * - `retryable: true` — transient (e.g. upstream 5xx); the runner / withRetry
 *   will re-run the operation according to the policy.
 * - `retryable: false` — permanent (e.g. 4xx that will not change on retry);
 *   the failure result is marked non-retryable so the scheduler does not
 *   re-queue the job.
 */
export class RetryPolicyError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	/** Optional explicit delay before retry (e.g. a `Retry-After` header). */
	readonly retryAfterMs: number | null;

	constructor(
		message: string,
		options: {
			code?: string;
			retryable?: boolean;
			retryAfterMs?: number | null;
		} = {},
	) {
		super(message);
		this.name = 'RetryPolicyError';
		this.code = options.code ?? 'RETRYABLE';
		this.retryable = options.retryable ?? true;
		this.retryAfterMs = options.retryAfterMs ?? null;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

/** True when the error signals the operation was aborted (never retried). */
export function isAbortError(error: unknown): boolean {
	return (
		isRecord(error) &&
		error.name === 'AbortError' &&
		(typeof error.message === 'string' || error.message === undefined)
	);
}

/**
 * Decide whether a thrown error represents a transient failure worth
 * retrying. Errors thrown by the fetch layer (e.g. connection failures)
 * surface as `TypeError`s; typed retry/classification comes from
 * {@link RetryPolicyError}.
 */
export function isRetryableError(
	error: unknown,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
	if (error instanceof RetryPolicyError) {
		return error.retryable;
	}
	if (isAbortError(error)) {
		return false;
	}
	if (error instanceof TypeError) {
		return policy.retryOnNetworkError;
	}
	// A handler may `throw` a failed execution result-shaped object; honor
	// its `retryable` flag if present.
	if (
		isRecord(error) &&
		error.status === 'failed' &&
		isRecord(error.error) &&
		typeof error.error.retryable === 'boolean'
	) {
		return error.error.retryable;
	}
	return false;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		if (signal) {
			const abort = (): void => {
				clearTimeout(timer);
				reject(
					signal.reason instanceof Error
						? signal.reason
						: new DOMException('Aborted', 'AbortError'),
				);
			};
			if (signal.aborted) {
				abort();
				return;
			}
			signal.addEventListener('abort', abort, { once: true });
		}
	});

export interface WithRetryOptions {
	/** Retry policy override; defaults to DEFAULT_RETRY_POLICY. */
	policy?: Partial<RetryPolicy>;
	/** Abort the whole retry loop (throws an AbortError). */
	signal?: AbortSignal;
	/**
	 * Override the retryability decision. Defaults to {@link isRetryableError}
	 * with the resolved policy.
	 */
	shouldRetry?: (error: unknown) => boolean;
}

/**
 * Run `operation`, retrying transient failures with exponential backoff.
 *
 * Retries only errors for which the policy says retry (see
 * {@link isRetryableError}); permanent errors are rethrown immediately.
 * When the policy's `maxAttempts` is exhausted, the last error is rethrown.
 */
export async function withRetry<T>(
	operation: () => Promise<T> | T,
	options: WithRetryOptions = {},
): Promise<T> {
	const policy = resolveRetryPolicy(options.policy);
	const shouldRetry =
		options.shouldRetry ??
		((error: unknown): boolean => isRetryableError(error, policy));
	let lastError: unknown;

	for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
		if (options.signal?.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		try {
			return await operation();
		} catch (error) {
			// Never retry aborted operations.
			if (isAbortError(error)) {
				throw error;
			}
			lastError = error;
			if (!shouldRetry(error) || attempt >= policy.maxAttempts - 1) {
				throw error;
			}
			const retryAfterHint =
				error instanceof RetryPolicyError ? error.retryAfterMs : null;
			await sleep(
				calculateBackoffDelayMs(attempt, policy, retryAfterHint),
				options.signal,
			);
		}
	}
	// Unreachable: every loop iteration either returns or throws.
	throw lastError;
}
