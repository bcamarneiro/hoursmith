import type { AbsenceDay } from '../../services/absenceService';
import type { WeekWorklogEntry } from '../../stores/useDashboardStore';
import { getAbsenceKindLabel } from './absence';
import { buildProvenanceFooter, csvEscape, CSV_SEP as SEP } from './csvHelpers';
import { parseIsoDateLocal } from './date';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatDuration(seconds: number): string {
	const totalMinutes = Math.round(seconds / 60);
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	if (m === 0) return `${h}h`;
	if (h === 0) return `${m}m`;
	return `${h}h ${m}m`;
}

/**
 * Provenance metadata appended as a `# generated=…` footer line, mirroring
 * `buildCsvForUser`/`buildSummaryCsv` conventions for finance-grade exports.
 */
export interface WeeklyCsvProvenance {
	jiraHost?: string;
	sourceVersion?: string;
	generatedAt?: string;
}

function isEntryBackdated(entry: WeekWorklogEntry): boolean {
	// ADA-461: use the `isBackdated` flag set at fetch time (from the same
	// `classifyWorklog` call that the heatmap and the rest of the app use).
	// The previous approach re-synthesised a worklog from `entry.date` alone,
	// which discards the real `started`/`created` delta and therefore missed
	// Jira-native backdates — the root of the ~10h heatmap/CSV discrepancy.
	return entry.isBackdated ?? false;
}

export interface GenerateWeeklyCsvOptions {
	provenance?: WeeklyCsvProvenance;
	/** Append the `# generated=…` provenance footer line. Default true. */
	includeProvenance?: boolean;
	absenceDays?: Map<string, AbsenceDay>;
	includeAbsenceColumns?: boolean;
}

export function generateWeeklyCsv(
	weekStart: string,
	weekEnd: string,
	worklogs: WeekWorklogEntry[],
	provenanceOrOptions?: WeeklyCsvProvenance | GenerateWeeklyCsvOptions,
): string {
	// Backwards-compat: legacy callers pass a bare provenance object; new
	// callers pass an options object whose marker key is `provenance`
	// (`absenceDays`/`includeAbsenceColumns` are also accepted).
	const isOptionsShape =
		provenanceOrOptions !== undefined &&
		('provenance' in provenanceOrOptions ||
			'includeProvenance' in provenanceOrOptions ||
			'absenceDays' in provenanceOrOptions ||
			'includeAbsenceColumns' in provenanceOrOptions);
	const opts: GenerateWeeklyCsvOptions = isOptionsShape
		? (provenanceOrOptions as GenerateWeeklyCsvOptions)
		: { provenance: provenanceOrOptions as WeeklyCsvProvenance | undefined };
	const {
		provenance,
		includeProvenance = true,
		absenceDays,
		includeAbsenceColumns = false,
	} = opts;

	const baseHeaders = [
		'Date',
		'Day',
		'Issue Key',
		'Issue Summary',
		'Time Spent (hours)',
		'Time Spent (formatted)',
		'IsBackdated',
	];
	const headers = (
		includeAbsenceColumns
			? [...baseHeaders, 'IsAbsence', 'AbsenceKind']
			: baseHeaders
	).join(SEP);
	const metadata = [`Week Range`, `${weekStart} to ${weekEnd}`].join(SEP);

	// Sort by date then issue key
	const sorted = [...worklogs].sort((a, b) => {
		const dateCompare = a.date.localeCompare(b.date);
		if (dateCompare !== 0) return dateCompare;
		return a.issueKey.localeCompare(b.issueKey);
	});

	const classified = sorted.map((entry) => ({
		entry,
		isBackdated: isEntryBackdated(entry),
	}));

	const rows = classified.map(({ entry, isBackdated }) => {
		const d = parseIsoDateLocal(entry.date);
		const dayLabel = DAY_LABELS[d.getDay()];
		const hours = entry.timeSpentSeconds / 3600;
		const formatted = formatDuration(entry.timeSpentSeconds);
		const baseCols = [
			csvEscape(entry.date),
			csvEscape(dayLabel),
			csvEscape(entry.issueKey),
			csvEscape(entry.issueSummary ?? ''),
			hours.toFixed(2),
			formatted,
			isBackdated ? 'true' : 'false',
		];
		if (!includeAbsenceColumns) return baseCols.join(SEP);
		const absence = absenceDays?.get(entry.date);
		return [
			...baseCols,
			absence ? 'true' : 'false',
			absence ? getAbsenceKindLabel(absence.kind) : '',
		].join(SEP);
	});

	const totalSeconds = sorted.reduce(
		(sum, entry) => sum + entry.timeSpentSeconds,
		0,
	);
	const backdatedSeconds = classified.reduce(
		(sum, c) => sum + (c.isBackdated ? c.entry.timeSpentSeconds : 0),
		0,
	);
	const nonBackdatedSeconds = totalSeconds - backdatedSeconds;
	const makeTotalRow = (label: string, seconds: number) => {
		const cols = [
			label,
			'',
			'',
			'',
			(seconds / 3600).toFixed(2),
			formatDuration(seconds),
			'',
		];
		if (includeAbsenceColumns) cols.push('', '');
		return cols.join(SEP);
	};
	const backdatedRow = makeTotalRow('Backdated', backdatedSeconds);
	const nonBackdatedRow = makeTotalRow('Non-backdated', nonBackdatedSeconds);
	const totalRow = makeTotalRow('Week Total', totalSeconds);
	const absenceDaysInWeek =
		includeAbsenceColumns && absenceDays
			? [...absenceDays.keys()].filter((d) => d >= weekStart && d <= weekEnd)
					.length
			: null;
	const absenceSubtotalRow =
		absenceDaysInWeek !== null
			? (() => {
					const cols = [
						'Absence Days',
						'',
						'',
						'',
						absenceDaysInWeek.toString(),
						'',
						'',
					];
					if (includeAbsenceColumns) cols.push('', '');
					return cols.join(SEP);
				})()
			: null;

	const subtotalRows = [backdatedRow, nonBackdatedRow, totalRow];
	if (absenceSubtotalRow) subtotalRows.push(absenceSubtotalRow);

	const lines = [metadata, headers, ...rows, ...subtotalRows];
	if (includeProvenance) {
		lines.push(
			buildProvenanceFooter({
				policy: 'logged',
				period: `${weekStart}..${weekEnd}`,
				provenance,
				omitMissingVersion: true,
			}),
		);
	}
	return lines.join('\n');
}
