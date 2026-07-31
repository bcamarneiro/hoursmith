/**
 * Tests for the wire format contracts (ADA-745).
 *
 * Pure validation — no network, no BullMQ. Exercises the version gate, the
 * job-data envelope, every execution-result field rule, per-kind success
 * payload contracts, and normalization.
 */

import { describe, expect, it } from 'vitest';

import {
	buildJobData,
	EXECUTION_KINDS,
	EXECUTION_RESULT_CONTRACTS,
	parseExecutionResult,
	parseJobData,
	WIRE_FORMAT_VERSION,
	WireFormatError,
	type ExecutionResult,
} from '../wireFormat.js';

const EXECUTION_ID = '0a8c4f90-2d1e-4a7b-9c3f-6e5d4c3b2a11';

const ARTIFACT = {
	reportUrl: 'https://files.hoursmith.dev/reports/timesheet-2026-07.csv?token=abc',
	fileName: 'timesheet-2026-07.csv',
	contentType: 'text/csv',
	byteSize: 12_345,
};

const SUMMARY = { scanned: 42, replayed: 3 };

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		executionId: EXECUTION_ID,
		kind: 'report-export',
		status: 'success',
		completedAt: '2026-07-31T18:10:00Z',
		artifact: ARTIFACT,
		...overrides,
	};
}

describe('WIRE_FORMAT_VERSION', () => {
	it('is version 1', () => {
		expect(WIRE_FORMAT_VERSION).toBe(1);
	});
});

describe('EXECUTION_KINDS / EXECUTION_RESULT_CONTRACTS', () => {
	it('exposes the supported execution kinds', () => {
		expect(EXECUTION_KINDS).toEqual(['reconcile', 'report-export']);
	});

	it('declares the success payload contract for every kind', () => {
		expect(EXECUTION_RESULT_CONTRACTS).toEqual({
			reconcile: { successPayload: 'summary' },
			'report-export': { successPayload: 'artifact' },
		});
	});
});

describe('buildJobData / parseJobData', () => {
	it('stamps the wire version onto a payload', () => {
		const payload = { executionId: EXECUTION_ID, kind: 'reconcile' };
		expect(buildJobData(payload)).toEqual({ wireVersion: 1, payload });
	});

	it('parses job data produced under the current version', () => {
		const payload = { executionId: EXECUTION_ID, kind: 'reconcile' };
		expect(parseJobData(buildJobData(payload))).toEqual({ wireVersion: 1, payload });
	});

	it('rejects job data from another wire version', () => {
		expect(() => parseJobData({ wireVersion: 0, payload: {} })).toThrow(WireFormatError);
		expect(() => parseJobData({ wireVersion: 0, payload: {} })).toThrow(/unsupported wire format version 0/);
		expect(() => parseJobData({ wireVersion: '1', payload: {} })).toThrow(/unsupported wire format version 1/);
	});

	it('rejects non-object job data', () => {
		expect(() => parseJobData(null)).toThrow(/job data must be an object/);
		expect(() => parseJobData('data')).toThrow(/job data must be an object/);
	});
});

describe('parseExecutionResult — success', () => {
	it('parses a valid report-export result with an artifact and drops unknown fields', () => {
		const result = parseExecutionResult(validResult({ unexpected: 'ignored' }));
		expect(result).toEqual({
			executionId: EXECUTION_ID,
			kind: 'report-export',
			status: 'success',
			completedAt: '2026-07-31T18:10:00Z',
			artifact: ARTIFACT,
		});
	});

	it('parses a valid reconcile result with a summary', () => {
		const result = parseExecutionResult({
			executionId: EXECUTION_ID,
			kind: 'reconcile',
			status: 'success',
			completedAt: '2026-07-31T18:10:00Z',
			summary: SUMMARY,
		});
		expect(result).toEqual({
			executionId: EXECUTION_ID,
			kind: 'reconcile',
			status: 'success',
			completedAt: '2026-07-31T18:10:00Z',
			summary: SUMMARY,
		});
	});

	it('rejects a report-export result without an artifact', () => {
		expect(() => parseExecutionResult(validResult({ artifact: undefined }))).toThrow(
			/result.artifact must be an object for report-export results/,
		);
	});

	it('rejects a reconcile result with an artifact instead of a summary', () => {
		expect(() =>
			parseExecutionResult({
				executionId: EXECUTION_ID,
				kind: 'reconcile',
				status: 'success',
				completedAt: '2026-07-31T18:10:00Z',
				artifact: ARTIFACT,
			}),
		).toThrow(/result.summary must be an object for reconcile results/);
	});
});

describe('parseExecutionResult — failure', () => {
	it('parses a valid failed result', () => {
		const result = parseExecutionResult({
			executionId: EXECUTION_ID,
			kind: 'report-export',
			status: 'failed',
			failedAt: '2026-07-31T18:10:00Z',
			error: { code: 'JIRA_API_ERROR', message: 'upstream returned 502', retryable: true },
		});
		expect(result).toEqual({
			executionId: EXECUTION_ID,
			kind: 'report-export',
			status: 'failed',
			failedAt: '2026-07-31T18:10:00Z',
			error: { code: 'JIRA_API_ERROR', message: 'upstream returned 502', retryable: true },
		});
	});

	it('parses a non-retryable failure', () => {
		const result = parseExecutionResult({
			executionId: EXECUTION_ID,
			kind: 'reconcile',
			status: 'failed',
			failedAt: '2026-07-31T18:10:00Z',
			error: { code: 'BAD_SCOPE', message: 'window outside retention', retryable: false },
		});
		expect((result as Extract<ExecutionResult, { status: 'failed' }>).error.retryable).toBe(false);
	});

	it('rejects a failure without error details', () => {
		expect(() =>
			parseExecutionResult({
				executionId: EXECUTION_ID,
				kind: 'report-export',
				status: 'failed',
				failedAt: '2026-07-31T18:10:00Z',
			}),
		).toThrow(/result.error must be an object/);
	});
});

describe('parseExecutionResult — envelope fields', () => {
	it('rejects non-object results', () => {
		expect(() => parseExecutionResult(null)).toThrow(/result must be an object/);
		expect(() => parseExecutionResult(['result'])).toThrow(/result must be an object/);
	});

	it('rejects a missing executionId', () => {
		const { executionId: _dropped, ...rest } = validResult();
		expect(() => parseExecutionResult(rest)).toThrow(/result.executionId must be a UUID v4/);
	});

	it('rejects a non-UUID-v4 executionId', () => {
		expect(() => parseExecutionResult(validResult({ executionId: 'not-a-uuid' }))).toThrow(
			/result.executionId must be a UUID v4/,
		);
		expect(() => parseExecutionResult(validResult({ executionId: '9c1f2e8a-6d4b-1f0e-9a2c-3b7d5e8f1a02' }))).toThrow(
			/result.executionId must be a UUID v4/,
		);
	});

	it('rejects an unknown kind', () => {
		expect(() => parseExecutionResult(validResult({ kind: 'backfill' }))).toThrow(
			/result.kind must be one of: reconcile, report-export/,
		);
	});

	it('rejects an unknown status', () => {
		expect(() => parseExecutionResult(validResult({ status: 'running' }))).toThrow(
			/result.status must be "success" or "failed"/,
		);
	});

	it('rejects an impossible completedAt timestamp', () => {
		expect(() => parseExecutionResult(validResult({ completedAt: '2026-02-30T18:10:00Z' }))).toThrow(
			/result.completedAt must be a real ISO-8601 UTC timestamp/,
		);
	});

	it('rejects a non-UTC completedAt timestamp', () => {
		expect(() => parseExecutionResult(validResult({ completedAt: '2026-07-31T18:10:00+01:00' }))).toThrow(
			/result.completedAt must be a real ISO-8601 UTC timestamp/,
		);
	});

	it('rejects an invalid failedAt timestamp', () => {
		expect(() =>
			parseExecutionResult({
				executionId: EXECUTION_ID,
				kind: 'reconcile',
				status: 'failed',
				failedAt: 'yesterday',
				error: { code: 'JIRA_API_ERROR', message: 'nope', retryable: true },
			}),
		).toThrow(/result.failedAt must be a real ISO-8601 UTC timestamp/);
	});
});

describe('parseExecutionResult — artifact rules', () => {
	it('rejects a non-https artifact URL', () => {
		expect(() => parseExecutionResult(validResult({ artifact: { ...ARTIFACT, reportUrl: 'http://files.hoursmith.dev/r.csv' } }))).toThrow(
			/result.artifact.reportUrl must be an absolute https URL/,
		);
		expect(() => parseExecutionResult(validResult({ artifact: { ...ARTIFACT, reportUrl: 'not a url' } }))).toThrow(
			/result.artifact.reportUrl must be an absolute https URL/,
		);
	});

	it('rejects an empty or oversized fileName', () => {
		expect(() => parseExecutionResult(validResult({ artifact: { ...ARTIFACT, fileName: '' } }))).toThrow(
			/result.artifact.fileName must be a non-empty string/,
		);
		expect(() => parseExecutionResult(validResult({ artifact: { ...ARTIFACT, fileName: 'x'.repeat(256) } }))).toThrow(
			/result.artifact.fileName must be a non-empty string/,
		);
	});

	it('rejects an empty contentType', () => {
		expect(() => parseExecutionResult(validResult({ artifact: { ...ARTIFACT, contentType: '' } }))).toThrow(
			/result.artifact.contentType must be a non-empty string/,
		);
	});

	it('rejects a negative or fractional byteSize', () => {
		expect(() => parseExecutionResult(validResult({ artifact: { ...ARTIFACT, byteSize: -1 } }))).toThrow(
			/result.artifact.byteSize must be a non-negative integer/,
		);
		expect(() => parseExecutionResult(validResult({ artifact: { ...ARTIFACT, byteSize: 1.5 } }))).toThrow(
			/result.artifact.byteSize must be a non-negative integer/,
		);
		expect(() => parseExecutionResult(validResult({ artifact: { ...ARTIFACT, byteSize: '12345' } }))).toThrow(
			/result.artifact.byteSize must be a non-negative integer/,
		);
	});
});

describe('parseExecutionResult — summary rules', () => {
	it('rejects negative or fractional counts', () => {
		expect(() =>
			parseExecutionResult({
				executionId: EXECUTION_ID,
				kind: 'reconcile',
				status: 'success',
				completedAt: '2026-07-31T18:10:00Z',
				summary: { scanned: -1, replayed: 0 },
			}),
		).toThrow(/result.summary.scanned must be a non-negative integer/);
		expect(() =>
			parseExecutionResult({
				executionId: EXECUTION_ID,
				kind: 'reconcile',
				status: 'success',
				completedAt: '2026-07-31T18:10:00Z',
				summary: { scanned: 1, replayed: 2.5 },
			}),
		).toThrow(/result.summary.replayed must be a non-negative integer/);
	});

	it('rejects a missing summary field', () => {
		expect(() =>
			parseExecutionResult({
				executionId: EXECUTION_ID,
				kind: 'reconcile',
				status: 'success',
				completedAt: '2026-07-31T18:10:00Z',
				summary: { scanned: 1 },
			}),
		).toThrow(/result.summary.replayed must be a non-negative integer/);
	});
});

describe('parseExecutionResult — error rules', () => {
	const FAILED = {
		executionId: EXECUTION_ID,
		kind: 'reconcile',
		status: 'failed',
		failedAt: '2026-07-31T18:10:00Z',
		error: { code: 'JIRA_API_ERROR', message: 'upstream returned 502', retryable: true },
	};

	it('rejects a malformed error code', () => {
		expect(() => parseExecutionResult({ ...FAILED, error: { ...FAILED.error, code: 'jira_api_error' } })).toThrow(
			/result.error.code must be SCREAMING_SNAKE/,
		);
		expect(() => parseExecutionResult({ ...FAILED, error: { ...FAILED.error, code: 'HAS SPACE' } })).toThrow(
			/result.error.code must be SCREAMING_SNAKE/,
		);
	});

	it('rejects an empty or oversized error message', () => {
		expect(() => parseExecutionResult({ ...FAILED, error: { ...FAILED.error, message: '' } })).toThrow(
			/result.error.message must be a non-empty string/,
		);
		expect(() =>
			parseExecutionResult({ ...FAILED, error: { ...FAILED.error, message: 'x'.repeat(2_001) } }),
		).toThrow(/result.error.message must be a non-empty string/);
	});

	it('rejects a non-boolean retryable flag', () => {
		expect(() => parseExecutionResult({ ...FAILED, error: { ...FAILED.error, retryable: 'yes' } })).toThrow(
			/result.error.retryable must be a boolean/,
		);
	});
});
