/**
 * Core serialization logic (ADA-746).
 *
 * The bridge between the execution-payload domain model and the wire format
 * that crosses the queue boundary: producers `serializeExecutionPayload` a
 * domain object into the canonical JSON bytes BullMQ stores, and consumers
 * `deserializeExecutionPayload` those bytes back into a validated
 * `ExecutionPayload` before doing any work.
 *
 * Invariants:
 * - Round-trip: `deserializeExecutionPayload(serializeExecutionPayload(p))`
 *   deep-equals `parseExecutionPayload(p)` — the normalized domain object.
 * - Byte-stable wire form: serialization always emits the same key order
 *   (executionId, kind, createdAt, scheduleId, scheduledFor, scope) and never
 *   carries unknown fields, so producers and consumers agree on the exact
 *   shape even across deploy skew.
 * - Loud at the boundary: a producer that hands over a malformed domain
 *   object gets an `ExecutionPayloadError` naming the offending field instead
 *   of silently enqueueing garbage; a consumer that reads malformed JSON
 *   fails the job loudly instead of half-executing it.
 */

import {
	type ExecutionPayload,
	ExecutionPayloadError,
	parseExecutionPayload,
} from './executionPayload.js';

/** Maximum wire length we will accept, in bytes (guards oversized queue jobs). */
const MAX_WIRE_BYTES = 256 * 1024;

const textEncoder = new TextEncoder();

/**
 * Serialize a validated execution-payload domain object to canonical wire
 * JSON. The payload is re-validated and normalized before stringification, so
 * the emitted bytes are exactly what `deserializeExecutionPayload` (and
 * `parseExecutionPayload`) accept, with a stable field order and no unknown
 * fields. Throws `ExecutionPayloadError` when the domain object violates a
 * wire rule (bad UUID, non-ISO timestamp, `from` after `to`, ...).
 */
export function serializeExecutionPayload(payload: ExecutionPayload): string {
	let plain: unknown;
	try {
		plain = JSON.parse(JSON.stringify(payload));
	} catch (error) {
		throw new ExecutionPayloadError(
			`execution payload could not be serialized: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const normalized = parseExecutionPayload(plain);
	return JSON.stringify(normalized);
}

/**
 * Deserialize wire JSON bytes into a validated `ExecutionPayload` domain
 * object. Runs the full schema validation, so a malformed or stale job fails
 * loudly at the top of the processor with an `ExecutionPayloadError` naming
 * the offending field. Throws `ExecutionPayloadError` for non-JSON input,
 * oversized payloads, and payloads that violate a wire rule.
 */
export function deserializeExecutionPayload(wire: string): ExecutionPayload {
	if (typeof wire !== 'string') {
		throw new ExecutionPayloadError(
			`execution payload wire must be a JSON string, got ${JSON.stringify(wire)}.`,
		);
	}
	const wireBytes = textEncoder.encode(wire).length;
	if (wireBytes > MAX_WIRE_BYTES) {
		throw new ExecutionPayloadError(
			`execution payload wire exceeds ${MAX_WIRE_BYTES} bytes (${wireBytes} received).`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(wire);
	} catch (error) {
		throw new ExecutionPayloadError(
			`execution payload wire must be valid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return parseExecutionPayload(parsed);
}
