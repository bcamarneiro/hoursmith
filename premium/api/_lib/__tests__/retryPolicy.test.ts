/**
 * Tests for the retry policy & error handling module (ADA-739).
 *
 * Covers policy resolution/validation, backoff math (including jitter and
 * `Retry-After`-style hints), error classification, and the generic
 * `withRetry` engine. Timer-dependent behavior uses Vitest fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	calculateBackoffDelayMs,
	DEFAULT_RETRY_POLICY,
	isAbortError,
	isRetryableError,
	isRetryableHttpStatus,
	RETRYABLE_HTTP_STATUSES,
	RetryPolicyError,
	resolveRetryPolicy,
	withRetry,
} from '../retryPolicy.js';

describe('resolveRetryPolicy', () => {
	it('returns the defaults when no override is given', () => {
		expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
		expect(resolveRetryPolicy(null)).toEqual(DEFAULT_RETRY_POLICY);
	});

	it('merges a partial override into the defaults', () => {
		const policy = resolveRetryPolicy({ maxAttempts: 5 });
		expect(policy.maxAttempts).toBe(5);
		expect(policy.baseDelayMs).toBe(DEFAULT_RETRY_POLICY.baseDelayMs);
		expect(policy.jitter).toBe('full');
	});

	it('rejects invalid maxAttempts', () => {
		expect(() => resolveRetryPolicy({ maxAttempts: 0 })).toThrow(RangeError);
		expect(() => resolveRetryPolicy({ maxAttempts: -1 })).toThrow(RangeError);
		expect(() => resolveRetryPolicy({ maxAttempts: 1.5 })).toThrow(RangeError);
	});

	it('rejects invalid delays and factor', () => {
		expect(() => resolveRetryPolicy({ baseDelayMs: -1 })).toThrow(RangeError);
		expect(() =>
			resolveRetryPolicy({ maxDelayMs: 500, baseDelayMs: 1_000 }),
		).toThrow(RangeError);
		expect(() => resolveRetryPolicy({ factor: 0.5 })).toThrow(RangeError);
	});

	it('rejects an invalid jitter value', () => {
		expect(() =>
			resolveRetryPolicy({ jitter: 'exponential' as never }),
		).toThrow(RangeError);
	});

	it('rejects a non-array retryableStatuses and a non-boolean retryOnNetworkError', () => {
		expect(() =>
			resolveRetryPolicy({ retryableStatuses: 429 as never }),
		).toThrow(RangeError);
		expect(() =>
			resolveRetryPolicy({ retryOnNetworkError: 'yes' as never }),
		).toThrow(RangeError);
	});
});

describe('isRetryableHttpStatus', () => {
	it('classifies the documented transient statuses as retryable', () => {
		expect(RETRYABLE_HTTP_STATUSES).toEqual([
			408, 425, 429, 500, 502, 503, 504,
		]);
		for (const status of RETRYABLE_HTTP_STATUSES) {
			expect(isRetryableHttpStatus(status)).toBe(true);
		}
	});

	it('treats other statuses as permanent by default', () => {
		expect(isRetryableHttpStatus(200)).toBe(false);
		expect(isRetryableHttpStatus(404)).toBe(false);
		expect(isRetryableHttpStatus(400)).toBe(false);
	});

	it('honors a custom status list from the policy', () => {
		const policy = resolveRetryPolicy({ retryableStatuses: [418] });
		expect(isRetryableHttpStatus(418, policy)).toBe(true);
		expect(isRetryableHttpStatus(500, policy)).toBe(false);
	});
});

describe('calculateBackoffDelayMs', () => {
	const policy = resolveRetryPolicy({
		jitter: 'none',
		baseDelayMs: 1_000,
		maxDelayMs: 5_000,
		factor: 2,
	});

	it('grows exponentially from the base delay', () => {
		expect(calculateBackoffDelayMs(0, policy)).toBe(1_000);
		expect(calculateBackoffDelayMs(1, policy)).toBe(2_000);
		expect(calculateBackoffDelayMs(2, policy)).toBe(4_000);
	});

	it('caps the delay at maxDelayMs', () => {
		expect(calculateBackoffDelayMs(3, policy)).toBe(5_000);
		expect(calculateBackoffDelayMs(10, policy)).toBe(5_000);
	});

	it('prefers an explicit retry-after hint over backoff math', () => {
		expect(calculateBackoffDelayMs(0, policy, 250)).toBe(250);
		expect(calculateBackoffDelayMs(3, policy, 250)).toBe(250);
	});

	it('ignores a non-positive retry-after hint', () => {
		expect(calculateBackoffDelayMs(0, policy, 0)).toBe(1_000);
		expect(calculateBackoffDelayMs(0, policy, -10)).toBe(1_000);
	});

	it('applies full jitter in [0, raw]', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		try {
			expect(
				calculateBackoffDelayMs(0, resolveRetryPolicy({ jitter: 'full' })),
			).toBe(500);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('applies equal jitter in [raw/2, raw]', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		try {
			expect(
				calculateBackoffDelayMs(0, resolveRetryPolicy({ jitter: 'equal' })),
			).toBe(750);
		} finally {
			vi.restoreAllMocks();
		}
	});
});

describe('RetryPolicyError', () => {
	it('defaults to retryable with a RETRYABLE code', () => {
		const error = new RetryPolicyError('upstream 503');
		expect(error.name).toBe('RetryPolicyError');
		expect(error.code).toBe('RETRYABLE');
		expect(error.retryable).toBe(true);
		expect(error.retryAfterMs).toBeNull();
	});

	it('carries explicit retry semantics', () => {
		const error = new RetryPolicyError('jira rejected', {
			code: 'JIRA_400',
			retryable: false,
			retryAfterMs: 42,
		});
		expect(error.code).toBe('JIRA_400');
		expect(error.retryable).toBe(false);
		expect(error.retryAfterMs).toBe(42);
	});
});

describe('isRetryableError / isAbortError', () => {
	it('follows the flag on a RetryPolicyError', () => {
		expect(isRetryableError(new RetryPolicyError('503'))).toBe(true);
		expect(
			isRetryableError(new RetryPolicyError('400', { retryable: false })),
		).toBe(false);
	});

	it('classifies network TypeErrors as retryable when enabled', () => {
		expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
		const noNetworkRetry = resolveRetryPolicy({ retryOnNetworkError: false });
		expect(
			isRetryableError(new TypeError('fetch failed'), noNetworkRetry),
		).toBe(false);
	});

	it('never retries aborted operations', () => {
		const abortError = new DOMException('Aborted', 'AbortError');
		expect(isAbortError(abortError)).toBe(true);
		expect(isRetryableError(abortError)).toBe(false);
	});

	it('treats plain errors as permanent', () => {
		expect(isRetryableError(new Error('jira exploded'))).toBe(false);
		expect(isRetryableError('a string')).toBe(false);
		expect(isRetryableError(null)).toBe(false);
	});

	it('honors the retryable flag on a failed result-shaped throw', () => {
		expect(
			isRetryableError({ status: 'failed', error: { retryable: true } }),
		).toBe(true);
		expect(
			isRetryableError({ status: 'failed', error: { retryable: false } }),
		).toBe(false);
	});
});

describe('withRetry', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const transientPolicy = {
		maxAttempts: 3,
		baseDelayMs: 100,
		jitter: 'none' as const,
	};

	it('resolves on the first attempt without retrying', async () => {
		const operation = vi.fn().mockResolvedValue('ok');

		await expect(withRetry(operation)).resolves.toBe('ok');
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('retries transient failures with exponential backoff until success', async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new RetryPolicyError('upstream 503'))
			.mockRejectedValueOnce(new RetryPolicyError('upstream 503'))
			.mockResolvedValueOnce('ok');

		const promise = withRetry(operation, { policy: transientPolicy });

		await vi.advanceTimersByTimeAsync(0);
		expect(operation).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(100);
		expect(operation).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(200);
		expect(operation).toHaveBeenCalledTimes(3);

		await expect(promise).resolves.toBe('ok');
	});

	it('rethrows the last error after exhausting all attempts', async () => {
		const operation = vi
			.fn()
			.mockRejectedValue(new RetryPolicyError('still down'));

		const promise = withRetry(operation, { policy: transientPolicy });
		// Attach the assertion immediately so the final rejection (which fires
		// during the timer advance below) is never an unhandled rejection.
		const assertion = expect(promise).rejects.toMatchObject({
			name: 'RetryPolicyError',
			message: 'still down',
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(operation).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(operation).toHaveBeenCalledTimes(3);

		await assertion;
	});

	it('does not retry permanent errors', async () => {
		const operation = vi
			.fn()
			.mockRejectedValue(
				new RetryPolicyError('jira rejected', { retryable: false }),
			);

		await expect(
			withRetry(operation, { policy: transientPolicy }),
		).rejects.toMatchObject({
			message: 'jira rejected',
		});
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('honors a retry-after hint over the computed backoff', async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(
				new RetryPolicyError('rate limited', { retryAfterMs: 50 }),
			)
			.mockResolvedValueOnce('ok');

		const promise = withRetry(operation, { policy: transientPolicy });

		await vi.advanceTimersByTimeAsync(0);
		expect(operation).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(49);
		expect(operation).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(operation).toHaveBeenCalledTimes(2);

		await expect(promise).resolves.toBe('ok');
	});

	it('aborts the wait when the signal fires and stops retrying', async () => {
		const controller = new AbortController();
		const operation = vi.fn().mockRejectedValue(new RetryPolicyError('down'));

		const promise = withRetry(operation, {
			policy: { maxAttempts: 5, baseDelayMs: 1_000, jitter: 'none' },
			signal: controller.signal,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(operation).toHaveBeenCalledTimes(1);

		controller.abort();

		await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('refuses to run when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			withRetry(vi.fn(), { signal: controller.signal }),
		).rejects.toMatchObject({
			name: 'AbortError',
		});
	});

	it('respects maxAttempts of 1 (no retries)', async () => {
		const operation = vi.fn().mockRejectedValue(new RetryPolicyError('down'));

		await expect(
			withRetry(operation, { policy: { maxAttempts: 1 } }),
		).rejects.toMatchObject({ message: 'down' });
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('supports a custom shouldRetry predicate', async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new Error('custom transient'))
			.mockResolvedValueOnce('ok');

		const promise = withRetry(operation, {
			policy: transientPolicy,
			shouldRetry: () => true,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(operation).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(100);
		expect(operation).toHaveBeenCalledTimes(2);

		await expect(promise).resolves.toBe('ok');
	});
});
