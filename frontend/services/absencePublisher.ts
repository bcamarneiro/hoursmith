/**
 * absencePublisher.ts — Publish mapped absence records to a destination sink.
 *
 * This module is the publishing step of the absence mapping pipeline: once
 * `absenceEventMapper` has turned expanded calendar entries into canonical
 * `UserAbsenceUpsert[]` records, the publisher hands them to a sink — the
 * user_absences upsert endpoint, a local store, a subscriber notification —
 * and reports what actually landed.
 *
 * Failure guarantees (fail-safe by design):
 *  - `publishAbsenceRecords` NEVER throws. A sink that rejects the whole
 *    batch triggers a per-record fallback pass so a single bad record (or a
 *    flaky batch endpoint) cannot drop the rest of the feed. Individual
 *    failures are logged with their record index and reason and counted in
 *    the result.
 *  - `mapAndPublish` wraps the mapping step in try/catch as well: a mapping
 *    error is logged and returned as `mappingError` instead of propagating,
 *    so the surrounding feed pipeline keeps running for the other feeds.
 *  - When no sink is wired yet (pipeline still landing), mapped records fall
 *    back to a debug-logging sink so mapping output is never silently lost.
 *
 * @module
 */

import type { UserAbsenceUpsert } from './absences';
import { logger } from '../react/utils/logger';

// --- Types ---

/**
 * Destination for mapped absence records. May be async; must not reject the
 * caller's pipeline — errors are caught and accounted for by the publisher.
 */
export type AbsencePublishSink = (
	records: UserAbsenceUpsert[],
) => Promise<void> | void;

/** One failed record delivery attempt. */
export interface AbsencePublishFailure {
	/** Index of the record in the attempted batch (-1 for mapping errors). */
	index: number;
	reason: string;
}

/**
 * Outcome of a publish attempt. `attempted` is the number of records handed
 * to the sink; `published` counts records the sink accepted; `failed` counts
 * records that were skipped after the per-record fallback.
 */
export interface AbsencePublishResult {
	attempted: number;
	published: number;
	failed: number;
	failures: AbsencePublishFailure[];
	/** Set when the mapping step itself threw — nothing was published. */
	mappingError?: string;
}

// --- Defaults ---

/**
 * Fail-safe fallback sink used when the pipeline has not wired a real sink
 * yet: mapped records are logged (debug) so they are never silently dropped.
 */
export const DEFAULT_ABSENCE_SINK: AbsencePublishSink = (records) => {
	logger.debug(
		`[Absence] no sink wired — ${records.length} mapped record(s) kept local (debug only)`,
		records,
	);
};

// --- Publishing ---

/**
 * Deliver mapped records to a sink with per-record error containment.
 *
 * Attempts the whole batch first; if the sink rejects the batch, retries
 * record-by-record so a single failing record cannot take down the feed.
 * Never throws — every failure is logged and returned in the result.
 */
export async function publishAbsenceRecords(
	records: UserAbsenceUpsert[],
	sink?: AbsencePublishSink,
): Promise<AbsencePublishResult> {
	const target = sink ?? DEFAULT_ABSENCE_SINK;

	if (records.length === 0) {
		return { attempted: 0, published: 0, failed: 0, failures: [] };
	}

	try {
		await target(records);
		return {
			attempted: records.length,
			published: records.length,
			failed: 0,
			failures: [],
		};
	} catch (batchError) {
		logger.warn(
			'[Absence] publish batch rejected — falling back to per-record delivery:',
			batchError,
		);
		return publishAbsenceRecordsOneByOne(records, target);
	}
}

/**
 * Deliver records one at a time, containing each failure. Internal fallback
 * used when the batch delivery rejects.
 */
async function publishAbsenceRecordsOneByOne(
	records: UserAbsenceUpsert[],
	sink: AbsencePublishSink,
): Promise<AbsencePublishResult> {
	let published = 0;
	const failures: AbsencePublishFailure[] = [];

	for (let index = 0; index < records.length; index++) {
		try {
			await sink([records[index]]);
			published++;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failures.push({ index, reason });
			logger.warn(
				`[Absence] failed to publish record ${index} (${records[index].user_id} @ ${records[index].absence_date}):`,
				error,
			);
		}
	}

	return {
		attempted: records.length,
		published,
		failed: failures.length,
		failures,
	};
}

// --- Map + publish orchestration ---

/**
 * Run a mapping step and, only if it succeeds, publish its records.
 *
 * The mapping step is wrapped in try/catch (fail-safe): a mapping error is
 * logged, reported via `mappingError`, and never propagated — and the sink
 * is not invoked, because there is nothing valid to publish.
 *
 * @param produceRecords - The mapping step producing canonical records.
 * @param sink           - Destination sink (defaults to the debug-log sink).
 */
export async function mapAndPublish(
	produceRecords: () => UserAbsenceUpsert[] | Promise<UserAbsenceUpsert[]>,
	sink?: AbsencePublishSink,
): Promise<AbsencePublishResult> {
	let records: UserAbsenceUpsert[];
	try {
		records = await produceRecords();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		logger.error('[Absence] mapping failed — nothing published:', error);
		return {
			attempted: 0,
			published: 0,
			failed: 0,
			failures: [{ index: -1, reason }],
			mappingError: reason,
		};
	}

	logger.debug(
		`[Absence] mapping succeeded — publishing ${records.length} record(s)`,
	);
	return publishAbsenceRecords(records, sink);
}
