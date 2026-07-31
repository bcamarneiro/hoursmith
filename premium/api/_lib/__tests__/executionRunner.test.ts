/**
 * Tests for the execution runner & handler registry (ADA-744).
 *
 * Pure execution-flow validation — no network, no BullMQ. Exercises handler
 * registration rules, the end-to-end runJob path (wire version gate, payload
 * validation, dispatch, result validation), unexpected handler throws, and the
 * result-vs-payload consistency gates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionPayloadError } from '../executionPayload.js';
import {
	ExecutionRunner,
	ExecutionRunnerError,
	HANDLER_FAILED_ERROR_CODE,
} from '../executionRunner.js';
import { RetryPolicyError } from '../retryPolicy.js';
import {
	buildJobData,
	type ExecutionResult,
	WireFormatError,
} from '../wireFormat.js';

const EXECUTION_ID = '0a8c4f90-2d1e-4a7b-9c3f-6e5d4c3b2a11';
const USER_ID = '11111111-1111-4111-8111-111111111111';

const ARTIFACT = {
	reportUrl:
		'https://files.hoursmith.dev/reports/timesheet-2026-07.csv?token=abc',
	fileName: 'timesheet-2026-07.csv',
	contentType: 'text/csv',
	byteSize: 12_345,
};

const SUMMARY = { scanned: 42, replayed: 3 };

function reconcilePayload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		executionId: EXECUTION_ID,
		kind: 'reconcile',
		createdAt: '2026-07-31T18:00:00Z',
		...overrides,
	};
}

function reportExportPayload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		executionId: EXECUTION_ID,
		kind: 'report-export',
		createdAt: '2026-07-31T18:00:00Z',
		scope: {
			userId: USER_ID,
			from: '2026-07-27',
			to: '2026-07-31',
			format: 'csv',
			tz: 'America/New_York',
		},
		...overrides,
	};
}

function reconcileResult(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		executionId: EXECUTION_ID,
		kind: 'reconcile',
		status: 'success',
		completedAt: '2026-07-31T18:10:00Z',
		summary: SUMMARY,
		...overrides,
	};
}

function artifactResult(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		executionId: EXECUTION_ID,
		kind: 'report-export',
		status: 'success',
		completedAt: '2026-07-31T18:10:00Z',
		artifact: ARTIFACT,
		...overrides,
	};
}

describe('registerHandler / unregisterHandler', () => {
	it('registers a handler for a known kind and reports it', () => {
		const runner = new ExecutionRunner();
		const handler = () => artifactResult() as unknown as ExecutionResult;

		expect(runner.hasHandler('reconcile')).toBe(false);
		runner.registerHandler('reconcile', handler);

		expect(runner.hasHandler('reconcile')).toBe(true);
		expect(runner.registeredKinds()).toEqual(['reconcile']);
	});

	it('rejects a duplicate registration for the same kind', () => {
		const runner = new ExecutionRunner();
		const handler = () => artifactResult() as unknown as ExecutionResult;

		runner.registerHandler('reconcile', handler);
		expect(() => runner.registerHandler('reconcile', handler)).toThrow(
			ExecutionRunnerError,
		);
		expect(() => runner.registerHandler('reconcile', handler)).toThrow(
			/already registered/,
		);
	});

	it('rejects an unknown execution kind at registration', () => {
		const runner = new ExecutionRunner();
		const handler = () => artifactResult() as unknown as ExecutionResult;

		expect(() =>
			runner.registerHandler('bogus-kind' as never, handler),
		).toThrow(ExecutionRunnerError);
		expect(() =>
			runner.registerHandler('bogus-kind' as never, handler),
		).toThrow(/unknown execution kind/);
	});

	it('rejects a non-function handler', () => {
		const runner = new ExecutionRunner();

		expect(() =>
			runner.registerHandler('reconcile', 'not-a-function' as never),
		).toThrow(ExecutionRunnerError);
		expect(() =>
			runner.registerHandler('reconcile', 'not-a-function' as never),
		).toThrow(/must be a function/);
	});

	it('unregisters a handler and is idempotent for absent kinds', () => {
		const runner = new ExecutionRunner();
		const handler = () => artifactResult() as unknown as ExecutionResult;

		runner.registerHandler('reconcile', handler);
		runner.unregisterHandler('reconcile');
		runner.unregisterHandler('reconcile');

		expect(runner.hasHandler('reconcile')).toBe(false);
		expect(runner.registeredKinds()).toEqual([]);
	});

	it('allows re-registration after an unregister', () => {
		const runner = new ExecutionRunner();
		const handler = () => artifactResult() as unknown as ExecutionResult;

		runner.registerHandler('reconcile', handler);
		runner.unregisterHandler('reconcile');
		expect(() => runner.registerHandler('reconcile', handler)).not.toThrow();
	});
});

describe('runJob — happy path', () => {
	it('executes a reconcile job and returns the validated result', async () => {
		const runner = new ExecutionRunner();
		let receivedPayload: unknown;
		runner.registerHandler('reconcile', (payload) => {
			receivedPayload = payload;
			return reconcileResult() as unknown as ExecutionResult;
		});

		const result = await runner.runJob(buildJobData(reconcilePayload()));

		expect(receivedPayload).toEqual({
			executionId: EXECUTION_ID,
			kind: 'reconcile',
			createdAt: '2026-07-31T18:00:00Z',
			scheduleId: undefined,
			scheduledFor: undefined,
			scope: undefined,
		});
		expect(result).toEqual({
			executionId: EXECUTION_ID,
			kind: 'reconcile',
			status: 'success',
			completedAt: '2026-07-31T18:10:00Z',
			summary: SUMMARY,
		});
	});

	it('executes a report-export job through an async handler', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler('report-export', async (payload) => {
			expect(payload.kind).toBe('report-export');
			return artifactResult() as unknown as ExecutionResult;
		});

		const result = await runner.runJob(buildJobData(reportExportPayload()));

		expect(result).toEqual({
			executionId: EXECUTION_ID,
			kind: 'report-export',
			status: 'success',
			completedAt: '2026-07-31T18:10:00Z',
			artifact: ARTIFACT,
		});
	});

	it('passes through a structured failed result returned by a handler', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler(
			'reconcile',
			() =>
				reconcileResult({
					status: 'failed',
					failedAt: '2026-07-31T18:10:00Z',
					error: {
						code: 'JIRA_API_ERROR',
						message: 'timeout',
						retryable: true,
					},
				}) as unknown as ExecutionResult,
		);

		const result = await runner.runJob(buildJobData(reconcilePayload()), {
			// Retry is disabled: this test targets result pass-through, not the
			// retry loop (which would re-run a retryable failure).
			retry: false,
		});

		expect(result.status).toBe('failed');
		if (result.status === 'failed') {
			expect(result.error).toEqual({
				code: 'JIRA_API_ERROR',
				message: 'timeout',
				retryable: true,
			});
		}
	});

	it('drops unknown fields from the handler result during normalization', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler(
			'reconcile',
			() =>
				reconcileResult({
					internalNotes: 'should not leak',
				}) as unknown as ExecutionResult,
		);

		const result = await runner.runJob(buildJobData(reconcilePayload()));

		expect(result).not.toHaveProperty('internalNotes');
	});
});

describe('runJob — producer-side gates', () => {
	it('refuses job data from another wire-format generation', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler(
			'reconcile',
			() => reconcileResult() as unknown as ExecutionResult,
		);

		await expect(
			runner.runJob({ wireVersion: 0, payload: reconcilePayload() }),
		).rejects.toThrow(WireFormatError);
		await expect(
			runner.runJob({ wireVersion: 0, payload: reconcilePayload() }),
		).rejects.toThrow(/unsupported wire format version 0/);
	});

	it('refuses a malformed execution payload', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler(
			'reconcile',
			() => reconcileResult() as unknown as ExecutionResult,
		);

		const malformed = reconcilePayload({ kind: 'evaporate' });
		await expect(runner.runJob(buildJobData(malformed))).rejects.toThrow(
			ExecutionPayloadError,
		);
	});

	it('fails loudly when no handler is registered for the payload kind', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler(
			'report-export',
			() => artifactResult() as unknown as ExecutionResult,
		);

		await expect(
			runner.runJob(buildJobData(reconcilePayload())),
		).rejects.toThrow(ExecutionRunnerError);
		await expect(
			runner.runJob(buildJobData(reconcilePayload())),
		).rejects.toThrow(/no handler registered for execution kind "reconcile"/);
	});
});

describe('runJob — handler failure handling', () => {
	it('converts an unexpected handler throw into a structured failed result', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler('reconcile', () => {
			throw new Error('jira exploded');
		});

		const result = await runner.runJob(buildJobData(reconcilePayload()));

		expect(result.status).toBe('failed');
		if (result.status === 'failed') {
			expect(result.executionId).toBe(EXECUTION_ID);
			expect(result.kind).toBe('reconcile');
			expect(result.error).toEqual({
				code: HANDLER_FAILED_ERROR_CODE,
				message: 'jira exploded',
				retryable: true,
			});
			expect(result.failedAt).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/,
			);
		}
	});

	it('converts a rejected async handler into a structured failed result', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler('report-export', async () => {
			throw new Error('storage unavailable');
		});

		const result = await runner.runJob(buildJobData(reportExportPayload()));

		expect(result.status).toBe('failed');
		if (result.status === 'failed') {
			expect(result.error.message).toBe('storage unavailable');
		}
	});

	it('truncates oversized handler error messages to the wire limit', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler('reconcile', () => {
			throw new Error('x'.repeat(10_000));
		});

		const result = await runner.runJob(buildJobData(reconcilePayload()));

		expect(result.status).toBe('failed');
		if (result.status === 'failed') {
			expect(result.error.message.length).toBe(2_000);
		}
	});

	it('rejects a handler result that breaks the wire contract', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler(
			'report-export',
			() =>
				artifactResult({
					status: 'success',
					artifact: undefined,
				}) as unknown as ExecutionResult,
		);

		const promise = runner.runJob(buildJobData(reportExportPayload()));

		await expect(promise).rejects.toBeInstanceOf(ExecutionRunnerError);
		await expect(promise).rejects.toMatchObject({ code: 'invalid-result' });
		await expect(promise).rejects.toThrow(/breaks the wire contract/);
	});
});

describe('runJob — result consistency gates', () => {
	it('rejects a result whose kind does not match the executed payload', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler(
			'reconcile',
			() => artifactResult() as unknown as ExecutionResult,
		);

		await expect(
			runner.runJob(buildJobData(reconcilePayload())),
		).rejects.toThrow(ExecutionRunnerError);
		await expect(
			runner.runJob(buildJobData(reconcilePayload())),
		).rejects.toThrow(
			/result for kind "report-export" but the job payload was "reconcile"/,
		);
	});

	it('rejects a result whose executionId does not match the executed payload', async () => {
		const runner = new ExecutionRunner();
		runner.registerHandler(
			'reconcile',
			() =>
				reconcileResult({
					executionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				}) as unknown as ExecutionResult,
		);

		await expect(
			runner.runJob(buildJobData(reconcilePayload())),
		).rejects.toThrow(ExecutionRunnerError);
		await expect(
			runner.runJob(buildJobData(reconcilePayload())),
		).rejects.toThrow(
			/result for execution "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" but the job payload was/,
		);
	});
});

describe('runJob — retry policy (ADA-739)', () => {
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

	it('retries a handler that throws retryable errors, then succeeds', async () => {
		const runner = new ExecutionRunner();
		const handler = vi
			.fn()
			.mockRejectedValueOnce(new RetryPolicyError('upstream 503'))
			.mockRejectedValueOnce(new RetryPolicyError('upstream 503'))
			.mockResolvedValueOnce(reconcileResult() as unknown as ExecutionResult);
		runner.registerHandler('reconcile', handler);

		const promise = runner.runJob(buildJobData(reconcilePayload()), {
			retry: transientPolicy,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(handler).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(100);
		expect(handler).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(200);
		expect(handler).toHaveBeenCalledTimes(3);

		await expect(promise).resolves.toMatchObject({ status: 'success' });
	});

	it('returns a structured failure result after exhausting retries', async () => {
		const runner = new ExecutionRunner();
		const handler = vi
			.fn()
			.mockRejectedValue(new RetryPolicyError('upstream 503'));
		runner.registerHandler('reconcile', handler);

		const promise = runner.runJob(buildJobData(reconcilePayload()), {
			retry: transientPolicy,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(handler).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(handler).toHaveBeenCalledTimes(3);

		await expect(promise).resolves.toMatchObject({
			status: 'failed',
			error: { code: HANDLER_FAILED_ERROR_CODE, retryable: true },
		});
	});

	it('does not retry a permanent handler error and marks it non-retryable', async () => {
		const runner = new ExecutionRunner();
		const handler = vi
			.fn()
			.mockRejectedValue(
				new RetryPolicyError('jira rejected', { retryable: false }),
			);
		runner.registerHandler('reconcile', handler);

		const promise = runner.runJob(buildJobData(reconcilePayload()), {
			retry: transientPolicy,
		});

		await vi.advanceTimersByTimeAsync(10_000);

		await expect(promise).resolves.toMatchObject({
			status: 'failed',
			error: { message: 'jira rejected', retryable: false },
		});
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('does not retry plain handler errors (left to job-level retries)', async () => {
		const runner = new ExecutionRunner();
		const handler = vi.fn().mockRejectedValue(new Error('jira exploded'));
		runner.registerHandler('reconcile', handler);

		const promise = runner.runJob(buildJobData(reconcilePayload()), {
			retry: transientPolicy,
		});

		await vi.advanceTimersByTimeAsync(10_000);

		await expect(promise).resolves.toMatchObject({
			status: 'failed',
			error: { retryable: true },
		});
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('retries a returned failed result flagged retryable, then succeeds', async () => {
		const runner = new ExecutionRunner();
		const handler = vi
			.fn()
			.mockResolvedValueOnce(
				reconcileResult({
					status: 'failed',
					failedAt: '2026-07-31T18:10:00Z',
					error: {
						code: 'JIRA_API_ERROR',
						message: 'timeout',
						retryable: true,
					},
				}) as unknown as ExecutionResult,
			)
			.mockResolvedValueOnce(reconcileResult() as unknown as ExecutionResult);
		runner.registerHandler('reconcile', handler);

		const promise = runner.runJob(buildJobData(reconcilePayload()), {
			retry: transientPolicy,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(handler).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(100);
		expect(handler).toHaveBeenCalledTimes(2);

		await expect(promise).resolves.toMatchObject({ status: 'success' });
	});

	it('does not retry a returned failed result flagged non-retryable', async () => {
		const runner = new ExecutionRunner();
		const handler = vi.fn().mockResolvedValue(
			reconcileResult({
				status: 'failed',
				failedAt: '2026-07-31T18:10:00Z',
				error: {
					code: 'JIRA_API_ERROR',
					message: 'jira rejected',
					retryable: false,
				},
			}) as unknown as ExecutionResult,
		);
		runner.registerHandler('reconcile', handler);

		const promise = runner.runJob(buildJobData(reconcilePayload()), {
			retry: transientPolicy,
		});

		await vi.advanceTimersByTimeAsync(10_000);

		await expect(promise).resolves.toMatchObject({
			status: 'failed',
			error: { code: 'JIRA_API_ERROR', retryable: false },
		});
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('honors a custom maxAttempts', async () => {
		const runner = new ExecutionRunner();
		const handler = vi
			.fn()
			.mockRejectedValue(new RetryPolicyError('upstream 503'));
		runner.registerHandler('reconcile', handler);

		const promise = runner.runJob(buildJobData(reconcilePayload()), {
			retry: { maxAttempts: 2, baseDelayMs: 100, jitter: 'none' },
		});

		await vi.advanceTimersByTimeAsync(10_000);

		await expect(promise).resolves.toMatchObject({ status: 'failed' });
		expect(handler).toHaveBeenCalledTimes(2);
	});

	it('disables in-process retries when retry is false', async () => {
		const runner = new ExecutionRunner();
		const handler = vi.fn().mockResolvedValue(
			reconcileResult({
				status: 'failed',
				failedAt: '2026-07-31T18:10:00Z',
				error: { code: 'JIRA_API_ERROR', message: 'timeout', retryable: true },
			}) as unknown as ExecutionResult,
		);
		runner.registerHandler('reconcile', handler);

		const result = await runner.runJob(buildJobData(reconcilePayload()), {
			retry: false,
		});

		expect(result.status).toBe('failed');
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('applies the default policy when no options are passed', async () => {
		const runner = new ExecutionRunner();
		const handler = vi
			.fn()
			.mockRejectedValue(new RetryPolicyError('upstream 503'));
		runner.registerHandler('reconcile', handler);

		const promise = runner.runJob(buildJobData(reconcilePayload()));

		await vi.advanceTimersByTimeAsync(0);
		expect(handler).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(handler).toHaveBeenCalledTimes(3);

		await expect(promise).resolves.toMatchObject({
			status: 'failed',
			error: { retryable: true },
		});
	});
});
