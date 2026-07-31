/**
 * Wire Format Contracts (ADA-745).
 *
 * Canonical, versioned contracts for every message the premium execution
 * pipeline exchanges across a process boundary (Redis/BullMQ job data, worker
 * results, persisted execution records). Producers and consumers each validate
 * against these contracts at their side of the wire so a malformed or stale
 * message fails loudly instead of being half-interpreted.
 *
 * The format is versioned: `WIRE_FORMAT_VERSION` is stamped into every message
 * (`JobWireData`), and `assertWireFormatVersion` makes a consumer refuse a
 * message produced under a different contract version. Bumping the version is
 * the signal that old producers and new consumers (or vice-versa) cannot
 * interoperate and need a coordinated deploy.
 *
 * The inbound side of the pipeline (the execution payload envelope carried by
 * each job) is specified in `executionPayload.ts` (ADA-742). This module owns
 * the result side — what a worker writes back after executing a job — plus the
 * job-data envelope that wraps a payload with its wire version. The two modules
 * share the execution kind vocabulary; keep `EXECUTION_KINDS` in sync until the
 * payload module lands, then import it from there.
 *
 * Validation is zero-stub: every field has a concrete rule enforced by
 * `parseExecutionResult` (UUID v4 execution ids, real ISO-8601 UTC timestamps,
 * known kinds, integer counts, https artifact URLs, structured error codes).
 * Invalid messages throw `WireFormatError` naming the offending field; unknown
 * fields are dropped from the normalized result so both sides always agree on
 * the exact shape.
 */

/** Current wire format version. Bump only on incompatible contract changes. */
export const WIRE_FORMAT_VERSION = 1 as const;

export type WireFormatVersion = typeof WIRE_FORMAT_VERSION;

/** Kinds of executions the premium pipeline can carry (shared with ADA-742). */
export const EXECUTION_KINDS = ['reconcile', 'report-export'] as const;

export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

/** Result statuses a worker can report back for an execution. */
export const EXECUTION_STATUSES = ['success', 'failed'] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * Per-kind success-payload contract: what a successful result of a given kind
 * is allowed to carry (`artifact` for report-export, `summary` for reconcile).
 * `parseExecutionResult` uses this to reject a result that mixes the wrong
 * payload with its kind.
 */
export const EXECUTION_RESULT_CONTRACTS: Record<
	ExecutionKind,
	{ readonly successPayload: 'artifact' | 'summary' }
> = {
	reconcile: { successPayload: 'summary' },
	'report-export': { successPayload: 'artifact' },
} as const;

/**
 * A produced report file. `reportUrl` is a signed https URL to the stored
 * artifact; `byteSize` is the exact byte length so clients can render sizes
 * without streaming the file.
 */
export interface ReportExportArtifact {
	/** Signed https URL to the stored report file. */
	reportUrl: string;
	/** File name the client should suggest on download (e.g. `timesheet-2026-07.csv`). */
	fileName: string;
	/** MIME content type of the artifact. */
	contentType: string;
	/** Exact byte length of the artifact. */
	byteSize: number;
}

/**
 * What a reconcile pass found and did. `scanned` counts the candidate rows the
 * worker inspected; `replayed` counts the rows it re-enqueued for processing.
 */
export interface ReconcileSummary {
	/** Number of candidate rows inspected during the pass. */
	scanned: number;
	/** Number of rows re-enqueued for processing during the pass. */
	replayed: number;
}

/**
 * Structured failure detail. `code` is a stable SCREAMING_SNAKE identifier
 * (e.g. `JIRA_API_ERROR`) clients can branch on without parsing prose;
 * `retryable` tells the scheduler whether re-running the execution is likely
 * to help.
 */
export interface ExecutionErrorInfo {
	/** Stable machine-readable error code (SCREAMING_SNAKE). */
	code: string;
	/** Human-readable description of what failed. */
	message: string;
	/** Whether re-running this execution is likely to succeed. */
	retryable: boolean;
}

/** A successful execution result; the success payload depends on `kind`. */
export interface ExecutionSuccess {
	/** Execution id of the job that produced this result (UUID v4). */
	executionId: string;
	/** Which execution kind this result is for. */
	kind: ExecutionKind;
	status: 'success';
	/** When the worker finished, in ISO-8601 UTC (e.g. `2026-07-31T18:00:00Z`). */
	completedAt: string;
	/** Report file produced by a `report-export` execution. */
	artifact?: ReportExportArtifact;
	/** Work summary produced by a `reconcile` execution. */
	summary?: ReconcileSummary;
}

/** A failed execution result. */
export interface ExecutionFailure {
	/** Execution id of the job that produced this result (UUID v4). */
	executionId: string;
	/** Which execution kind this result is for. */
	kind: ExecutionKind;
	status: 'failed';
	/** When the worker gave up, in ISO-8601 UTC. */
	failedAt: string;
	error: ExecutionErrorInfo;
}

/** Discriminated union of every result a worker can write back. */
export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

/**
 * The exact shape stored in a job's `data` on the wire: the payload envelope
 * plus the wire version so consumers can refuse messages from other contract
 * generations.
 */
export interface JobWireData<T = unknown> {
	wireVersion: typeof WIRE_FORMAT_VERSION;
	/** The execution payload envelope (see executionPayload.ts, ADA-742). */
	payload: T;
}

/** Stamp a payload with the current wire version before enqueueing. */
export function buildJobData<T>(payload: T): JobWireData<T> {
	return { wireVersion: WIRE_FORMAT_VERSION, payload };
}

/** Validate a job's `data` before trusting its payload. */
export function parseJobData(input: unknown): JobWireData {
	if (!isRecord(input)) {
		throw new WireFormatError('job data must be an object');
	}
	assertWireFormatVersion(input.wireVersion);
	return { wireVersion: WIRE_FORMAT_VERSION, payload: input.payload };
}

/** Throw unless `value` is the current wire format version. */
export function assertWireFormatVersion(
	value: unknown,
): asserts value is WireFormatVersion {
	if (value !== WIRE_FORMAT_VERSION) {
		throw new WireFormatError(
			`unsupported wire format version ${String(value)} (expected ${WIRE_FORMAT_VERSION})`,
		);
	}
}

export class WireFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WireFormatError';
	}
}

const UUID_V4_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ISO_UTC_RE =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z$/;

const ERROR_CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

const MAX_ERROR_MESSAGE_LENGTH = 2_000;

const MAX_FILE_NAME_LENGTH = 255;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` is a real ISO-8601 UTC timestamp (catches 2026-02-30 etc.). */
function isValidIsoUtcTimestamp(value: string): boolean {
	const match = ISO_UTC_RE.exec(value);
	if (match === null) {
		return false;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return false;
	}
	if (hour > 23 || minute > 59 || second > 59) {
		return false;
	}
	const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day &&
		date.getUTCHours() === hour &&
		date.getUTCMinutes() === minute &&
		date.getUTCSeconds() === second
	);
}

/** True when `value` is a non-negative safe integer. */
function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** True when `value` is an absolute https URL. */
function isHttpsUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.hostname.length > 0;
	} catch {
		return false;
	}
}

function parseReportExportArtifact(
	input: Record<string, unknown>,
): ReportExportArtifact {
	const reportUrl = input.reportUrl;
	if (typeof reportUrl !== 'string' || !isHttpsUrl(reportUrl)) {
		throw new WireFormatError(
			'result.artifact.reportUrl must be an absolute https URL',
		);
	}
	const fileName = input.fileName;
	if (
		typeof fileName !== 'string' ||
		fileName.length === 0 ||
		fileName.length > MAX_FILE_NAME_LENGTH
	) {
		throw new WireFormatError(
			'result.artifact.fileName must be a non-empty string',
		);
	}
	const contentType = input.contentType;
	if (typeof contentType !== 'string' || contentType.length === 0) {
		throw new WireFormatError(
			'result.artifact.contentType must be a non-empty string',
		);
	}
	const byteSize = input.byteSize;
	if (!isNonNegativeSafeInteger(byteSize)) {
		throw new WireFormatError(
			'result.artifact.byteSize must be a non-negative integer',
		);
	}
	return { reportUrl, fileName, contentType, byteSize };
}

function parseReconcileSummary(
	input: Record<string, unknown>,
): ReconcileSummary {
	const scanned = input.scanned;
	if (!isNonNegativeSafeInteger(scanned)) {
		throw new WireFormatError(
			'result.summary.scanned must be a non-negative integer',
		);
	}
	const replayed = input.replayed;
	if (!isNonNegativeSafeInteger(replayed)) {
		throw new WireFormatError(
			'result.summary.replayed must be a non-negative integer',
		);
	}
	return { scanned, replayed };
}

function parseExecutionErrorInfo(
	input: Record<string, unknown>,
): ExecutionErrorInfo {
	const code = input.code;
	if (typeof code !== 'string' || !ERROR_CODE_RE.test(code)) {
		throw new WireFormatError(
			'result.error.code must be SCREAMING_SNAKE (e.g. JIRA_API_ERROR)',
		);
	}
	const message = input.message;
	if (
		typeof message !== 'string' ||
		message.length === 0 ||
		message.length > MAX_ERROR_MESSAGE_LENGTH
	) {
		throw new WireFormatError(
			'result.error.message must be a non-empty string',
		);
	}
	const retryable = input.retryable;
	if (typeof retryable !== 'boolean') {
		throw new WireFormatError('result.error.retryable must be a boolean');
	}
	return { code, message, retryable };
}

/**
 * Validate a wire-format execution result. Returns a normalized result with
 * unknown fields dropped; throws `WireFormatError` naming the first invalid
 * field. The success payload is checked against the kind's contract
 * (`EXECUTION_RESULT_CONTRACTS`), so a `report-export` success cannot smuggle a
 * reconcile summary and vice-versa.
 */
export function parseExecutionResult(input: unknown): ExecutionResult {
	if (!isRecord(input)) {
		throw new WireFormatError('result must be an object');
	}
	const executionId = input.executionId;
	if (typeof executionId !== 'string' || !UUID_V4_RE.test(executionId)) {
		throw new WireFormatError('result.executionId must be a UUID v4');
	}
	const kind = input.kind;
	if (
		typeof kind !== 'string' ||
		!EXECUTION_KINDS.includes(kind as ExecutionKind)
	) {
		throw new WireFormatError(
			`result.kind must be one of: ${EXECUTION_KINDS.join(', ')}`,
		);
	}
	const status = input.status;
	if (
		typeof status !== 'string' ||
		!EXECUTION_STATUSES.includes(status as ExecutionStatus)
	) {
		throw new WireFormatError('result.status must be "success" or "failed"');
	}
	const kindValue = kind as ExecutionKind;
	if (status === 'failed') {
		const failedAt = input.failedAt;
		if (typeof failedAt !== 'string' || !isValidIsoUtcTimestamp(failedAt)) {
			throw new WireFormatError(
				'result.failedAt must be a real ISO-8601 UTC timestamp',
			);
		}
		const error = input.error;
		if (!isRecord(error)) {
			throw new WireFormatError('result.error must be an object');
		}
		return {
			executionId,
			kind: kindValue,
			status: 'failed',
			failedAt,
			error: parseExecutionErrorInfo(error),
		};
	}
	const completedAt = input.completedAt;
	if (typeof completedAt !== 'string' || !isValidIsoUtcTimestamp(completedAt)) {
		throw new WireFormatError(
			'result.completedAt must be a real ISO-8601 UTC timestamp',
		);
	}
	const contract = EXECUTION_RESULT_CONTRACTS[kindValue];
	if (contract.successPayload === 'artifact') {
		const artifact = input.artifact;
		if (!isRecord(artifact)) {
			throw new WireFormatError(
				'result.artifact must be an object for report-export results',
			);
		}
		return {
			executionId,
			kind: kindValue,
			status: 'success',
			completedAt,
			artifact: parseReportExportArtifact(artifact),
		};
	}
	const summary = input.summary;
	if (!isRecord(summary)) {
		throw new WireFormatError(
			'result.summary must be an object for reconcile results',
		);
	}
	return {
		executionId,
		kind: kindValue,
		status: 'success',
		completedAt,
		summary: parseReconcileSummary(summary),
	};
}
