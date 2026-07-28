/**
 * Processing Web Worker — offloads classify/aggregate/CSV from the main thread.
 *
 * Bundled by rspack as a separate chunk via `new Worker(new URL(…, import.meta.url))`.
 * Imports only pure functions with no DOM dependencies.
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

function handleMessage(event: MessageEvent<ProcessingWorkerRequest>) {
	const msg = event.data;
	let response: ProcessingWorkerResponse;

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
				response = { type: 'classify', id: msg.id, result: classified };
				break;
			}

			case 'buildHeatmap': {
				const buckets = buildMonthHeatmapBuckets(
					msg.payload.worklogs,
					msg.payload.email,
				);
				// Convert Maps to plain objects for structured-clone
				response = {
					type: 'buildHeatmap',
					id: msg.id,
					result: {
						data: Object.fromEntries(buckets.data),
						backdatedSeconds: Object.fromEntries(buckets.backdatedSeconds),
					},
				};
				break;
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
				response = {
					type: 'buildTeamSummaries',
					id: msg.id,
					result: serializeTeamSummaries(summaries),
				};
				break;
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
				response = { type: 'buildTimesheetCsv', id: msg.id, result: csv };
				break;
			}

			case 'buildTeamCsv': {
				// Reconstruct TeamMemberSummary with Maps from serialised form
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
				response = { type: 'buildTeamCsv', id: msg.id, result: csv };
				break;
			}

			default: {
				response = {
					type: 'error',
					id: (msg as { id: number }).id,
					error: `Unknown message type: ${(msg as { type: string }).type}`,
				};
			}
		}
	} catch (err) {
		response = {
			type: 'error',
			id: msg.id,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	self.postMessage(response);
}

self.addEventListener('message', handleMessage);
