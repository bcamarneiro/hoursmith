/**
 * Pure message-handling logic for the processing Web Worker.
 *
 * Extracted from processingWorker.ts so the handler logic can be
 * unit-tested without a Worker global.
 */

import { classifyWorklog } from '../react/utils/worklogClassifier';
import { buildMonthHeatmapBuckets } from '../react/hooks/useMonthHeatmapData';
import { buildTeamSummaries } from '../react/utils/teamReports';
import { buildTimesheetCsv } from '../react/utils/csv';
import { buildTeamCsv } from '../react/utils/teamCsvExport';
import { getWeekdaysBetween } from '../react/utils/teamReports';
import {
	deserializeUserAbsenceDays,
	deserializeAbsenceMap,
	serializeTeamSummaries,
	type ProcessingWorkerRequest,
	type ProcessingWorkerResponse,
} from './processingWorker.types';

/**
 * Process a single worker request and return the response.
 * Pure function — no Worker/DOM dependencies.
 */
export function processMessage(
	msg: ProcessingWorkerRequest,
): ProcessingWorkerResponse {
	try {
		switch (msg.type) {
			case 'classify': {
				const classified = msg.payload.worklogs.map((wl) => {
					const c = classifyWorklog(wl, msg.payload.classifierOptions);
					return {
						loggedOn: c.loggedOn,
						intendedFor: c.intendedFor,
						daysLate: c.daysLate,
						isBackdated: c.isBackdated,
						source: c.source,
						originalComment: c.originalComment,
					};
				});
				return { type: 'classify', id: msg.id, result: classified };
			}

			case 'buildHeatmap': {
				const buckets = buildMonthHeatmapBuckets(
					msg.payload.worklogs,
					msg.payload.email,
				);
				return {
					type: 'buildHeatmap',
					id: msg.id,
					result: {
						data: Object.fromEntries(buckets.data),
						backdatedSeconds: Object.fromEntries(buckets.backdatedSeconds),
					},
				};
			}

			case 'buildTeamSummaries': {
				const absenceDaysByUser = deserializeUserAbsenceDays(
					msg.payload.absenceDaysByUser,
				);
				const summaries = buildTeamSummaries(
					msg.payload.worklogs,
					msg.payload.weekStart,
					msg.payload.weekEnd,
					msg.payload.allowedUsers,
					absenceDaysByUser,
				);
				return {
					type: 'buildTeamSummaries',
					id: msg.id,
					result: serializeTeamSummaries(summaries),
				};
			}

			case 'buildTimesheetCsv': {
				const absenceDays = deserializeAbsenceMap(msg.payload.absenceDays);
				const csv = buildTimesheetCsv({
					worklogs: msg.payload.worklogs,
					issueSummaries: msg.payload.issueSummaries,
					policy: msg.payload.policy,
					period: msg.payload.period,
					classifierOptions: msg.payload.classifierOptions,
					provenance: msg.payload.provenance,
					includeProvenance: msg.payload.includeProvenance,
					absenceDays,
					includeAbsenceColumns: msg.payload.includeAbsenceColumns,
				});
				return { type: 'buildTimesheetCsv', id: msg.id, result: csv };
			}

			case 'buildTeamCsv': {
				const summaries = msg.payload.summaries.map((s) => ({
					...s,
					dailyHours: new Map(s.dailyHours),
				}));
				const weekdays =
					msg.payload.weekdays.length > 0
						? msg.payload.weekdays
						: getWeekdaysBetween(msg.payload.weekStart, msg.payload.weekEnd);
				const csv = buildTeamCsv(summaries, weekdays, {
					provenance: msg.payload.provenance,
					includeProvenance: msg.payload.includeProvenance,
					includeAbsenceColumns: msg.payload.includeAbsenceColumns,
				});
				return { type: 'buildTeamCsv', id: msg.id, result: csv };
			}

			default: {
				return {
					type: 'error',
					id: (msg as { id: number }).id,
					error: `Unknown message type: ${(msg as { type: string }).type}`,
				};
			}
		}
	} catch (err) {
		return {
			type: 'error',
			id: msg.id,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
