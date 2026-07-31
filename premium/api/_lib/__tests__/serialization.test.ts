/**
 * Tests for the core serialization logic (ADA-746).
 *
 * Pure — no network, no BullMQ. Exercises the canonical wire form, the
 * round-trip invariant, and every loud-failure path at both boundaries.
 */

import { describe, expect, it } from 'vitest';

import {
	type ExecutionPayload,
	ExecutionPayloadError,
	parseExecutionPayload,
	type ReportExportExecution,
} from '../executionPayload.js';
import {
	deserializeExecutionPayload,
	serializeExecutionPayload,
} from '../serialization.js';

const VALID_ENVELOPE = {
	executionId: '0a8c4f90-2d1e-4a7b-9c3f-6e5d4c3b2a11',
	kind: 'reconcile',
	createdAt: '2026-07-31T18:00:00Z',
	scheduledFor: '2026-07-31T18:05:00Z',
	scheduleId: 'raw-commits-reconcile',
};

const VALID_REPORT_EXPORT: ReportExportExecution = {
	...VALID_ENVELOPE,
	kind: 'report-export',
	scope: {
		userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
		from: '2026-07-27',
		to: '2026-07-31',
	},
};

const CANONICAL_RECONCILE_WIRE =
	'{"executionId":"0a8c4f90-2d1e-4a7b-9c3f-6e5d4c3b2a11","kind":"reconcile","createdAt":"2026-07-31T18:00:00Z","scheduleId":"raw-commits-reconcile","scheduledFor":"2026-07-31T18:05:00Z"}';

describe('serializeExecutionPayload', () => {
	it('serializes a reconcile payload to canonical wire JSON', () => {
		expect(serializeExecutionPayload(parseExecutionPayload(VALID_ENVELOPE))).toBe(
			CANONICAL_RECONCILE_WIRE,
		);
	});

	it('serializes a report-export payload with its scope', () => {
		const wire = serializeExecutionPayload(VALID_REPORT_EXPORT);
		expect(JSON.parse(wire)).toEqual({
			...VALID_ENVELOPE,
			kind: 'report-export',
			scope: {
				userId: '9c1f2e8a-6d4b-4f0e-9a2c-3b7d5e8f1a02',
				from: '2026-07-27',
				to: '2026-07-31',
			},
		});
	});

	it('emits a byte-stable wire form regardless of input key order', () => {
		const shuffled = parseExecutionPayload({
			scheduledFor: VALID_ENVELOPE.scheduledFor,
			scheduleId: VALID_ENVELOPE.scheduleId,
			createdAt: VALID_ENVELOPE.createdAt,
			kind: 'reconcile',
			executionId: VALID_ENVELOPE.executionId,
		});
		expect(serializeExecutionPayload(shuffled)).toBe(CANONICAL_RECONCILE_WIRE);
	});

	it('drops unknown fields from the emitted wire form', () => {
		const wire = serializeExecutionPayload({
			...VALID_ENVELOPE,
			sneaky: 'not-part-of-the-wire',
		} as ExecutionPayload);
		expect(JSON.parse(wire)).not.toHaveProperty('sneaky');
	});

	it('throws an ExecutionPayloadError for an invalid timestamp', () => {
		expect(() =>
			serializeExecutionPayload({
				...VALID_ENVELOPE,
				createdAt: '2026-02-30T18:00:00Z',
			} as ExecutionPayload),
		).toThrow(ExecutionPayloadError);
	});

	it('throws an ExecutionPayloadError naming the offending field', () => {
		expect(() =>
			serializeExecutionPayload({
				...VALID_ENVELOPE,
				scheduleId: 'UPPER_CASE',
			} as ExecutionPayload),
		).toThrow(/scheduleId/);
	});

	it('throws an ExecutionPayloadError when from is after to', () => {
		expect(() =>
			serializeExecutionPayload({
				...VALID_REPORT_EXPORT,
				scope: { ...VALID_REPORT_EXPORT.scope, from: '2026-08-01' },
			} as ExecutionPayload),
		).toThrow(ExecutionPayloadError);
	});

	it('throws an ExecutionPayloadError for a non-object payload', () => {
		expect(() => serializeExecutionPayload(null as unknown as ExecutionPayload)).toThrow(
			ExecutionPayloadError,
		);
	});
});

describe('deserializeExecutionPayload', () => {
	it('deserializes a canonical reconcile wire into the domain model', () => {
		expect(deserializeExecutionPayload(CANONICAL_RECONCILE_WIRE)).toEqual(
			parseExecutionPayload(VALID_ENVELOPE),
		);
	});

	it('deserializes a report-export wire with its scope', () => {
		const wire = serializeExecutionPayload(VALID_REPORT_EXPORT);
		expect(deserializeExecutionPayload(wire)).toEqual(
			parseExecutionPayload(VALID_REPORT_EXPORT),
		);
	});

	it('drops unknown fields carried on the wire', () => {
		const wire = serializeExecutionPayload({
			...VALID_ENVELOPE,
			extra: 1,
		} as ExecutionPayload);
		const wireWithJunk = CANONICAL_RECONCILE_WIRE.replace('}', ',"junk":true}');
		expect(deserializeExecutionPayload(wireWithJunk)).not.toHaveProperty('junk');
		expect(deserializeExecutionPayload(wire)).not.toHaveProperty('extra');
	});

	it('throws an ExecutionPayloadError for malformed JSON', () => {
		expect(() => deserializeExecutionPayload('{not json')).toThrow(
			ExecutionPayloadError,
		);
	});

	it('throws an ExecutionPayloadError for valid JSON with an invalid kind', () => {
		expect(() =>
			deserializeExecutionPayload(
				JSON.stringify({ ...VALID_ENVELOPE, kind: 'nope' }),
			),
		).toThrow(/kind/);
	});

	it('throws an ExecutionPayloadError for a non-string input', () => {
		expect(() =>
			deserializeExecutionPayload(42 as unknown as string),
		).toThrow(ExecutionPayloadError);
	});

	it('throws an ExecutionPayloadError for an oversized wire', () => {
		const bigWire = `{"padding":"${'x'.repeat(300 * 1024)}"}`;
		expect(() => deserializeExecutionPayload(bigWire)).toThrow(/exceeds/);
	});
});

describe('round-trip', () => {
	it('deserialize(serialize(payload)) equals the normalized payload for reconcile', () => {
		const payload = parseExecutionPayload(VALID_ENVELOPE);
		expect(deserializeExecutionPayload(serializeExecutionPayload(payload))).toEqual(
			payload,
		);
	});

	it('deserialize(serialize(payload)) equals the normalized payload for report-export', () => {
		const payload = parseExecutionPayload(VALID_REPORT_EXPORT);
		expect(deserializeExecutionPayload(serializeExecutionPayload(payload))).toEqual(
			payload,
		);
	});

	it('serialize(deserialize(wire)) is byte-stable for both kinds', () => {
		const reconcileWire = serializeExecutionPayload(
			parseExecutionPayload(VALID_ENVELOPE),
		);
		expect(serializeExecutionPayload(deserializeExecutionPayload(reconcileWire))).toBe(
			reconcileWire,
		);
		const reportWire = serializeExecutionPayload(VALID_REPORT_EXPORT);
		expect(serializeExecutionPayload(deserializeExecutionPayload(reportWire))).toBe(
			reportWire,
		);
	});
});
