/**
 * Tests for backoff/retry primitives (ADA-710).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { backoffDelay, sleep, withRetries } from '../backoff.js';

const BACKOFF = {
	initialDelayMs: 1_000,
	maxDelayMs: 8_000,
	factor: 2,
	jitter: false,
};

describe('backoffDelay', () => {
	it('starts at the initial delay', () => {
		expect(backoffDelay(0, BACKOFF)).toBe(1_000);
	});

	it('grows by the factor each attempt', () => {
		expect(backoffDelay(1, BACKOFF)).toBe(2_000);
		expect(backoffDelay(2, BACKOFF)).toBe(4_000);
	});

	it('caps at maxDelayMs', () => {
		expect(backoffDelay(10, BACKOFF)).toBe(8_000);
	});

	it('applies full jitter within [0, base]', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		expect(backoffDelay(1, { ...BACKOFF, jitter: true })).toBe(1_000);
		expect(backoffDelay(3, { ...BACKOFF, jitter: true })).toBe(4_000);
		vi.mocked(Math.random).mockRestore();
	});
});

describe('sleep', () => {
	it('resolves after the given ms', async () => {
		vi.useFakeTimers();
		const promise = sleep(50);
		const assertion = expect(promise).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(50);
		await assertion;
		vi.useRealTimers();
	});
});

describe('withRetries', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns the result on the first attempt', async () => {
		const fn = vi.fn().mockResolvedValue('ok');
		await expect(
			withRetries(fn, { attempts: 3, backoff: BACKOFF }),
		).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('retries until success and reports retries', async () => {
		vi.useFakeTimers();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce('ok');
		const onRetry = vi.fn();

		const promise = withRetries(fn, {
			attempts: 3,
			backoff: BACKOFF,
			onRetry,
		});
		const assertion = expect(promise).resolves.toBe('ok');
		await vi.advanceTimersByTimeAsync(10_000);
		await assertion;
		expect(fn).toHaveBeenCalledTimes(2);
		expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
	});

	it('throws the last error after exhausting attempts', async () => {
		vi.useFakeTimers();
		const fn = vi.fn().mockRejectedValue(new Error('boom'));
		const promise = withRetries(fn, { attempts: 3, backoff: BACKOFF });
		const assertion = expect(promise).rejects.toThrow('boom');
		await vi.advanceTimersByTimeAsync(30_000);
		await assertion;
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('supports unbounded attempts when configured', async () => {
		vi.useFakeTimers();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('down'))
			.mockRejectedValueOnce(new Error('down'))
			.mockResolvedValueOnce('recovered');
		const promise = withRetries(fn, { attempts: Infinity, backoff: BACKOFF });
		const assertion = expect(promise).resolves.toBe('recovered');
		await vi.advanceTimersByTimeAsync(20_000);
		await assertion;
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('does not retry non-retryable failures', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('nope'));
		await expect(
			withRetries(fn, {
				attempts: 5,
				backoff: BACKOFF,
				isRetryable: (error) => (error as Error).message !== 'nope',
			}),
		).rejects.toThrow('nope');
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
