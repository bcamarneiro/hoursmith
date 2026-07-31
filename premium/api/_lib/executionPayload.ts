/**
 * Execution Payload schema & interfaces (ADA-742).
 *
 * Every job the premium queue/worker pipeline executes carries an execution
 * payload envelope: the producer (cron scheduler, webhook handler) stamps the
 * envelope when a job is enqueued, and the consumer (see `_lib/baseWorker.ts`)
 * validates it at the top of its processor so a malformed or stale job is
 * failed loudly instead of half-executed.
 *
 * The envelope is a discriminated union on `kind`. Validation is zero-stub:
 * every field has a concrete rule (UUID shape, ISO-8601 UTC timestamps, enum
 * kind, kebab-case schedule ids, inclusive calendar-date windows) enforced by
 * `parseExecutionPayload`, which throws `ExecutionPayloadError` with a message
 * naming the offending field. Unknown fields are dropped from the normalized
 * payload so producers and consumers always agree on the exact shape.
 */

/** Kinds of executions the premium pipeline can carry. */
export const EXECUTION_KINDS = ['reconcile', 'report-export'] as const;

export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

/** Fields shared by every execution payload. */
export interface ExecutionEnvelope {
	/** Stable execution id (UUID v4); producers use it for idempotent replays. */
	executionId: string;
	/** What the worker should execute. */
	kind: ExecutionKind;
	/** When the job was enqueued, in ISO-8601 UTC (e.g. `2026-07-31T18:00:00Z`). */
	createdAt: string;
	/** Id of the cron task (see `worker/cron.ts` `CRON_TASKS`) that fired this execution. */
	scheduleId: string;
	/** When the execution was scheduled to run, in ISO-8601 UTC. */
	scheduledFor: string;
}

/**
 * Reconcile trigger: tells the worker to look for pending work (e.g. raw
 * commits that missed the webhook path). Carries no scope — the processor
 * derives what to reconcile from the queue it is draining.
 */
export interface ReconcileExecution extends ExecutionEnvelope {
	kind: 'reconcile';
}

/** What a scheduled report export should produce. */
export interface ReportExportScope {
	/** Supabase user id of the report owner (UUID). */
	userId: string;
	/** Inclusive export window start, calendar date `YYYY-MM-DD`. */
	from: string;
	/** Inclusive export window end, calendar date `YYYY-MM-DD`. */
	to: string;
}

/** Scheduled execution of a paid report export for one user and date window. */
export interface ReportExportExecution extends ExecutionEnvelope {
	kind: 'report-export';
	scope: ReportExportScope;
}

export type ExecutionPayload = ReconcileExecution | ReportExportExecution;

export class ExecutionPayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ExecutionPayloadError';
	}
}

const UUID_V4_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISO_UTC_RE =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z$/;

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const SCHEDULE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_SCHEDULE_ID_LENGTH = 128;

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

/** True when `value` is a real calendar date `YYYY-MM-DD` (catches 02-30). */
function isValidCalendarDate(value: string): boolean {
	const match = CALENDAR_DATE_RE.exec(value);
	if (match === null) {
		return false;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return false;
	}
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

interface ValidatedEnvelope {
	executionId: string;
	createdAt: string;
	scheduleId: string;
	scheduledFor: string;
}

function requireString(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	if (typeof value !== 'string' || value.length === 0) {
		throw new ExecutionPayloadError(
			`${field} must be a non-empty string, got ${JSON.stringify(value)}.`,
		);
	}
	return value;
}

/** Validate and normalize the fields shared by every execution payload. */
function parseEnvelope(record: Record<string, unknown>): ValidatedEnvelope {
	const executionId = requireString(record, 'executionId');
	if (!UUID_V4_RE.test(executionId)) {
		throw new ExecutionPayloadError(
			`executionId must be a UUID v4, got ${JSON.stringify(executionId)}.`,
		);
	}

	const createdAt = requireString(record, 'createdAt');
	if (!isValidIsoUtcTimestamp(createdAt)) {
		throw new ExecutionPayloadError(
			`createdAt must be an ISO-8601 UTC timestamp (e.g. "2026-07-31T18:00:00Z"), got ${JSON.stringify(createdAt)}.`,
		);
	}

	const scheduledFor = requireString(record, 'scheduledFor');
	if (!isValidIsoUtcTimestamp(scheduledFor)) {
		throw new ExecutionPayloadError(
			`scheduledFor must be an ISO-8601 UTC timestamp (e.g. "2026-07-31T18:00:00Z"), got ${JSON.stringify(scheduledFor)}.`,
		);
	}

	const scheduleId = requireString(record, 'scheduleId');
	if (
		scheduleId.length > MAX_SCHEDULE_ID_LENGTH ||
		!SCHEDULE_ID_RE.test(scheduleId)
	) {
		throw new ExecutionPayloadError(
			`scheduleId must be a kebab-case id (letters, digits, hyphens; <= ${MAX_SCHEDULE_ID_LENGTH} chars), got ${JSON.stringify(scheduleId)}.`,
		);
	}

	return { executionId, createdAt, scheduleId, scheduledFor };
}

/** Validate the `scope` of a report-export execution. */
function parseReportExportScope(scope: unknown): ReportExportScope {
	if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
		throw new ExecutionPayloadError(
			'kind "report-export" requires a scope object, got ' +
				`${JSON.stringify(scope)}.`,
		);
	}
	const record = scope as Record<string, unknown>;

	const userId = requireString(record, 'userId');
	if (!UUID_RE.test(userId)) {
		throw new ExecutionPayloadError(
			`scope.userId must be a UUID, got ${JSON.stringify(userId)}.`,
		);
	}

	const from = requireString(record, 'from');
	if (!isValidCalendarDate(from)) {
		throw new ExecutionPayloadError(
			`scope.from must be a valid calendar date (YYYY-MM-DD), got ${JSON.stringify(from)}.`,
		);
	}

	const to = requireString(record, 'to');
	if (!isValidCalendarDate(to)) {
		throw new ExecutionPayloadError(
			`scope.to must be a valid calendar date (YYYY-MM-DD), got ${JSON.stringify(to)}.`,
		);
	}

	if (from > to) {
		throw new ExecutionPayloadError(
			`scope.from (${from}) must not be after scope.to (${to}).`,
		);
	}

	return { userId, from, to };
}

/**
 * Validate an unknown job payload and normalize it to an `ExecutionPayload`.
 * Throws `ExecutionPayloadError` on the first rule violation, naming the
 * offending field. Unknown fields are dropped from the returned object.
 */
export function parseExecutionPayload(input: unknown): ExecutionPayload {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new ExecutionPayloadError(
			`execution payload must be a plain object, got ${JSON.stringify(input)}.`,
		);
	}
	const record = input as Record<string, unknown>;

	const rawKind = requireString(record, 'kind');
	if (!(EXECUTION_KINDS as readonly string[]).includes(rawKind)) {
		throw new ExecutionPayloadError(
			`kind must be one of ${EXECUTION_KINDS.map((k) => `"${k}"`).join(', ')}, got ${JSON.stringify(rawKind)}.`,
		);
	}
	const kind = rawKind as ExecutionKind;

	const envelope = parseEnvelope(record);
	switch (kind) {
		case 'reconcile':
			return {
				executionId: envelope.executionId,
				kind: 'reconcile',
				createdAt: envelope.createdAt,
				scheduleId: envelope.scheduleId,
				scheduledFor: envelope.scheduledFor,
			};
		case 'report-export':
			return {
				executionId: envelope.executionId,
				kind: 'report-export',
				createdAt: envelope.createdAt,
				scheduleId: envelope.scheduleId,
				scheduledFor: envelope.scheduledFor,
				scope: parseReportExportScope(record.scope),
			};
	}
}
