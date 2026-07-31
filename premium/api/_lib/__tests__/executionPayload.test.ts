/**
 * Tests for the execution payload schema (ADA-742).
 *
 * Pure validation — no network, no BullMQ. Exercises every field rule:
 * envelope fields, optional scheduleId/scheduledFor, per-kind scope,
 * reconcile scope, report-export format/tz, unknown-field rejection,
 * error messages, and normalization.
 */

import { describe, expect, it } from 'vitest';

import {
	EXECUTION_KINDS,
	ExecutionPayloadError,
	parseExecutionPayload,
	type ReconcileExecution,
	type ReportExportExecution,
} from '../executionPayload.js';

const VALID_ENVELOPE = {
	executionId: '0a8c4f90-2d1e-4a7b-9c3f-6e5d4c3b2a11',
	kind: 'reconcile',
	createdAt: '2026-07-31T18:00:00Z',
	scheduledFor: '2026-07-31T18:05:00Z',
	scheduleId: 'raw-commits-reconcile',
};

describe('EXECUTION_KINDS', () => {
	it('exposes the supported execution kinds', () => {
		expect(EXECUTION_KINDS).toEqual(['reconcile', 'report-export']);
	});
});

describe('parseExecutionPayload', () => {
	// --- envelope basics ---

	it('parses a valid reconcile payload with all envelope fields', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'reconcile',
		});
		expect(payload).toEqual({
			executionId: VALID_ENVELOPE.executionId,
			kind: 'reconcile',
			createdAt: VALID_ENVELOPE.createdAt,
			scheduleId: VALID_ENVELOPE.scheduleId,
			scheduledFor: VALID_ENVELOPE.scheduledFor,
		});
	});

	it('parses a reconcile payload without optional scheduleId/scheduledFor', () => {
		const payload = parseExecutionPayload({
			executionId: '0a8c4f90-2d1e-4a7b-9c3f-6e5d4c3b2a11',
			kind: 'reconcile',
			createdAt: '2026-07-31T18:00:00Z',
		});
		expect(payload).toEqual({
			executionId: '0a8c4f90-2d1e-4a7b-9c3f-6e5d4c3b2a11',
			kind: 'reconcile',
			createdAt: '2026-07-31T18:00:00Z',
		});
	});

	it('parses a report-export payload with optional scheduleId/scheduledFor omitted', () => {
		const payload = parseExecutionPayload({
			executionId: '0a8c4f90-2d1e-4a7b-9c3f-6e5d4c3b2a11',
			kind: 'report-export',
			createdAt: '2026-07-31T18:00:00Z',
			scope: {
				userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
				from: '2026-07-27',
				to: '2026-07-31',
				format: 'csv',
				tz: 'America/New_York',
			},
		});
		expect(payload.kind).toBe('report-export');
		expect((payload as ReportExportExecution).scope.format).toBe('csv');
	});

	// --- report-export scope ---

	it('parses a valid report-export payload with format and tz', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'report-export',
			scope: {
				userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
				from: '2026-07-27',
				to: '2026-07-31',
				format: 'xlsx',
				tz: 'Europe/London',
			},
		});
		expect(payload).toEqual({
			executionId: VALID_ENVELOPE.executionId,
			kind: 'report-export',
			createdAt: VALID_ENVELOPE.createdAt,
			scheduleId: VALID_ENVELOPE.scheduleId,
			scheduledFor: VALID_ENVELOPE.scheduledFor,
			scope: {
				userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
				from: '2026-07-27',
				to: '2026-07-31',
				format: 'xlsx',
				tz: 'Europe/London',
			},
		});
	});

	it('rejects an invalid report-export format', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'report-export',
				scope: {
					userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
					from: '2026-07-27',
					to: '2026-07-31',
					format: 'pdf',
					tz: 'America/New_York',
				},
			}),
		).toThrow(/scope\.format must be one of "csv", "xlsx"/);
	});

	it('rejects an invalid report-export timezone', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'report-export',
				scope: {
					userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
					from: '2026-07-27',
					to: '2026-07-31',
					format: 'csv',
					tz: 'not-a-timezone',
				},
			}),
		).toThrow(/scope\.tz must be an IANA timezone/);
	});

	it('accepts report-export csv format', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'report-export',
			scope: {
				userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
				from: '2026-07-27',
				to: '2026-07-31',
				format: 'csv',
				tz: 'UTC',
			},
		}) as ReportExportExecution;
		expect(payload.scope.format).toBe('csv');
	});

	// --- reconcile scope ---

	it('parses a reconcile payload without scope', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'reconcile',
		}) as ReconcileExecution;
		expect(payload.scope).toBeUndefined();
	});

	it('parses a reconcile payload with a userId scope', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'reconcile',
			scope: { userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02' },
		}) as ReconcileExecution;
		expect(payload.scope).toEqual({
			userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
		});
	});

	it('parses a reconcile payload with a teamId scope', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'reconcile',
			scope: { teamId: '8b2d3f9a-5c1e-4e0f-8a1b-2a6c4d3e0f99' },
		}) as ReconcileExecution;
		expect(payload.scope).toEqual({
			teamId: '8b2d3f9a-5c1e-4e0f-8a1b-2a6c4d3e0f99',
		});
	});

	it('parses a reconcile payload with since timestamp', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'reconcile',
			scope: { since: '2026-07-30T00:00:00Z' },
		}) as ReconcileExecution;
		expect(payload.scope).toEqual({
			since: '2026-07-30T00:00:00Z',
		});
	});

	it('parses a reconcile payload with for duration', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'reconcile',
			scope: { for: 'P7D' },
		}) as ReconcileExecution;
		expect(payload.scope).toEqual({
			for: 'P7D',
		});
	});

	it('parses a reconcile payload with includeDeleted', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'reconcile',
			scope: { includeDeleted: true },
		}) as ReconcileExecution;
		expect(payload.scope).toEqual({
			includeDeleted: true,
		});
	});

	it('parses a reconcile payload with includeDeleted false', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'reconcile',
			scope: { includeDeleted: false },
		}) as ReconcileExecution;
		expect(payload.scope).toEqual({
			includeDeleted: false,
		});
	});

	it('parses a reconcile payload with full scope', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'reconcile',
			scope: {
				userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
				since: '2026-07-30T00:00:00Z',
				includeDeleted: true,
			},
		}) as ReconcileExecution;
		expect(payload.scope).toEqual({
			userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
			since: '2026-07-30T00:00:00Z',
			includeDeleted: true,
		});
	});

	it('rejects reconcile scope with both userId and teamId', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'reconcile',
				scope: {
					userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
					teamId: '8b2d3f9a-5c1e-4e0f-8a1b-2a6c4d3e0f99',
				},
			}),
		).toThrow(/reconcile scope cannot carry both userId and teamId/);
	});

	it('rejects reconcile scope with both since and for', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'reconcile',
				scope: {
					since: '2026-07-30T00:00:00Z',
					for: 'P7D',
				},
			}),
		).toThrow(/reconcile scope cannot carry both since and for/);
	});

	it('rejects reconcile scope with invalid since timestamp', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'reconcile',
				scope: { since: 'not-a-date' },
			}),
		).toThrow(/reconcile scope\.since must be an ISO-8601 UTC timestamp/);
	});

	it('rejects reconcile scope with invalid for duration', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'reconcile',
				scope: { for: '7d' },
			}),
		).toThrow(
			/reconcile scope\.for must be an ISO-8601 duration \(e\.g\. "P7D"\)/,
		);
	});

	it('rejects reconcile scope with non-UUID userId', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'reconcile',
				scope: { userId: 'bob@example.com' },
			}),
		).toThrow(/reconcile scope\.userId must be a UUID/);
	});

	it('rejects reconcile scope with non-UUID teamId', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'reconcile',
				scope: { teamId: 'not-a-uuid' },
			}),
		).toThrow(/reconcile scope\.teamId must be a UUID/);
	});

	it('rejects reconcile scope with non-boolean includeDeleted', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'reconcile',
				scope: { includeDeleted: 'yes' },
			}),
		).toThrow(/reconcile scope\.includeDeleted must be a boolean/);
	});

	it('rejects reconcile scope with unknown keys', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'reconcile',
				scope: { extraStuff: 1 },
			}),
		).toThrow(/reconcile scope has unknown key "extraStuff"/);
	});

	// --- unknown top-level keys ---

	it('rejects unknown top-level keys', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'reconcile',
				unexpected: 'no',
			}),
		).toThrow(/execution payload has unknown key "unexpected"/);
	});

	// --- input validation ---

	it('rejects non-object inputs', () => {
		for (const input of [null, undefined, 'raw', 42, [], true]) {
			expect(() => parseExecutionPayload(input)).toThrow(ExecutionPayloadError);
		}
	});

	it('rejects a missing or empty kind', () => {
		expect(() =>
			parseExecutionPayload({ ...VALID_ENVELOPE, kind: undefined }),
		).toThrow(/kind must be a non-empty string/);
		expect(() =>
			parseExecutionPayload({ ...VALID_ENVELOPE, kind: '' }),
		).toThrow(/kind must be a non-empty string/);
	});

	it('rejects an unknown kind', () => {
		expect(() =>
			parseExecutionPayload({ ...VALID_ENVELOPE, kind: 'explode' }),
		).toThrow(
			/kind must be one of "reconcile", "report-export", got "explode"/,
		);
	});

	it('rejects a non-UUID-v4 executionId', () => {
		for (const executionId of [
			'not-a-uuid',
			'0a8c4f90-2d1e-3a7b-9c3f-6e5d4c3b2a11', // v3, not v4
			'0a8c4f90-2d1e-4a7b-9c3f-6e5d4c3b2a1', // too short
		]) {
			expect(() =>
				parseExecutionPayload({ ...VALID_ENVELOPE, executionId }),
			).toThrow(/executionId must be a UUID v4/);
		}
	});

	it('accepts a v4 executionId case-insensitively', () => {
		expect(
			parseExecutionPayload({
				...VALID_ENVELOPE,
				executionId: '0A8C4F90-2D1E-4A7B-9C3F-6E5D4C3B2A11',
				kind: 'reconcile',
			}).executionId,
		).toBe('0A8C4F90-2D1E-4A7B-9C3F-6E5D4C3B2A11');
	});

	it('rejects invalid ISO-8601 UTC timestamps', () => {
		for (const createdAt of [
			'2026-07-31T18:00:00', // missing Z
			'2026-07-31 18:00:00Z', // space separator
			'2026-02-30T18:00:00Z', // Feb 30 does not exist
			'2026-13-01T18:00:00Z', // month 13
			'2026-07-31T24:00:00Z', // hour 24
			'2026-07-31T18:60:00Z', // minute 60
			'not-a-timestamp',
		]) {
			expect(() =>
				parseExecutionPayload({ ...VALID_ENVELOPE, createdAt }),
			).toThrow(/createdAt must be an ISO-8601 UTC timestamp/);
		}
	});

	it('accepts timestamps with fractional seconds', () => {
		expect(
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'reconcile',
				createdAt: '2026-07-31T18:00:00.123456Z',
			}).createdAt,
		).toBe('2026-07-31T18:00:00.123456Z');
	});

	it('rejects invalid scheduledFor when present', () => {
		expect(() =>
			parseExecutionPayload({ ...VALID_ENVELOPE, scheduledFor: 'tomorrow' }),
		).toThrow(/scheduledFor must be an ISO-8601 UTC timestamp/);
	});

	it('rejects invalid scheduleId when present', () => {
		for (const scheduleId of [
			'UPPERCASE',
			'has space',
			'double--dash',
			'trailing-dash-',
			'under_score',
			'a'.repeat(129),
		]) {
			expect(() =>
				parseExecutionPayload({ ...VALID_ENVELOPE, scheduleId }),
			).toThrow(/scheduleId must be a kebab-case id/);
		}
	});

	it('accepts a single-word schedule id', () => {
		expect(
			parseExecutionPayload({
				...VALID_ENVELOPE,
				scheduleId: 'reconcile',
				kind: 'reconcile',
			}).scheduleId,
		).toBe('reconcile');
	});

	// --- report-export scope errors ---

	it('rejects a report-export payload without a scope', () => {
		expect(() =>
			parseExecutionPayload({ ...VALID_ENVELOPE, kind: 'report-export' }),
		).toThrow(/kind "report-export" requires a scope object/);
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'report-export',
				scope: null,
			}),
		).toThrow(/kind "report-export" requires a scope object/);
	});

	it('rejects a non-UUID scope.userId', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'report-export',
				scope: {
					userId: 'bob@example.com',
					from: '2026-07-27',
					to: '2026-07-31',
					format: 'csv',
					tz: 'UTC',
				},
			}),
		).toThrow(/scope\.userId must be a UUID/);
	});

	it('rejects invalid calendar dates in scope', () => {
		for (const badDate of [
			'2026-02-30',
			'2026-13-01',
			'2026-00-10',
			'07-27-2026',
			'20260727',
			'not-a-date',
		]) {
			expect(() =>
				parseExecutionPayload({
					...VALID_ENVELOPE,
					kind: 'report-export',
					scope: {
						userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
						from: badDate,
						to: '2026-07-31',
						format: 'csv',
						tz: 'UTC',
					},
				}),
			).toThrow(/scope\.from must be a valid calendar date/);
		}
	});

	it('accepts a leap-day calendar date', () => {
		const payload = parseExecutionPayload({
			...VALID_ENVELOPE,
			kind: 'report-export',
			scope: {
				userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
				from: '2024-02-29',
				to: '2024-02-29',
				format: 'csv',
				tz: 'UTC',
			},
		}) as ReportExportExecution;
		expect(payload.scope).toEqual({
			userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
			from: '2024-02-29',
			to: '2024-02-29',
			format: 'csv',
			tz: 'UTC',
		});
	});

	it('rejects a window where from is after to', () => {
		expect(() =>
			parseExecutionPayload({
				...VALID_ENVELOPE,
				kind: 'report-export',
				scope: {
					userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
					from: '2026-07-31',
					to: '2026-07-27',
					format: 'csv',
					tz: 'UTC',
				},
			}),
		).toThrow(
			/scope\.from \(2026-07-31\) must not be after scope\.to \(2026-07-27\)/,
		);
	});

	it('accepts a single-day window (from equals to)', () => {
		expect(
			(
				parseExecutionPayload({
					...VALID_ENVELOPE,
					kind: 'report-export',
					scope: {
						userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
						from: '2026-07-31',
						to: '2026-07-31',
						format: 'xlsx',
						tz: 'Asia/Tokyo',
					},
				}) as ReportExportExecution
			).scope,
		).toEqual({
			userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
			from: '2026-07-31',
			to: '2026-07-31',
			format: 'xlsx',
			tz: 'Asia/Tokyo',
		});
	});
});
