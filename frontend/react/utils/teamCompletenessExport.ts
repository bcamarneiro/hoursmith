import type { TeamMemberSummary } from '../../services/teamService';
import {
	buildProvenanceFooter,
	type CsvProvenance,
	csvEscape,
	CSV_SEP as SEP,
} from './csvHelpers';
import { describeOnTimeStatus } from './onTimeStatus';
import { buildXlsx, type XlsxRow } from './xlsx';

/**
 * Completeness export (ADA-390): hand a lead's manager / HR / PMO the
 * completeness picture — per member expected vs. logged, completeness %, and
 * on-time status — as CSV or a real `.xlsx`. Distinct from the per-day
 * `buildTeamCsv` breakdown; this is the summary managers ask for.
 */

export interface TeamCompletenessRow {
	displayName: string;
	email: string;
	expectedHours: number;
	loggedHours: number;
	/** logged / expected, 0–100+, rounded. 0-expected members read 100 if they
	 *  logged anything, else 0 (a bare division would be NaN/Infinity). */
	completenessPct: number;
	/** Human-readable on-time label, or '—' when no deadline was configured. */
	onTimeStatus: string;
}

const COLUMNS = [
	'Team Member',
	'Email',
	'Expected (h)',
	'Logged (h)',
	'Completeness (%)',
	'On-time',
] as const;

function round1(seconds: number): number {
	return Math.round((seconds / 3600) * 10) / 10;
}

function completenessPct(member: TeamMemberSummary): number {
	if (member.targetSeconds > 0) {
		return Math.round((member.totalSeconds / member.targetSeconds) * 100);
	}
	return member.totalSeconds > 0 ? 100 : 0;
}

export function buildTeamCompletenessRows(
	members: TeamMemberSummary[],
): TeamCompletenessRow[] {
	return members.map((member) => ({
		displayName: member.displayName,
		email: member.email,
		expectedHours: round1(member.targetSeconds),
		loggedHours: round1(member.totalSeconds),
		completenessPct: completenessPct(member),
		onTimeStatus: member.onTimeStatus
			? describeOnTimeStatus(member.onTimeStatus).label
			: '—',
	}));
}

export interface TeamCompletenessExportOptions {
	provenance?: CsvProvenance;
	/** Append the `# generated=…` provenance footer line. Default true. */
	includeProvenance?: boolean;
	/** Period label for the provenance footer, e.g. "2026-03-02..2026-03-08". */
	period?: string;
}

export function buildTeamCompletenessCsv(
	members: TeamMemberSummary[],
	options: TeamCompletenessExportOptions = {},
): string {
	const { provenance, includeProvenance = true, period } = options;
	const rows = buildTeamCompletenessRows(members);

	const lines = [
		COLUMNS.join(SEP),
		...rows.map((row) =>
			[
				csvEscape(row.displayName),
				csvEscape(row.email),
				row.expectedHours.toFixed(1),
				row.loggedHours.toFixed(1),
				String(row.completenessPct),
				csvEscape(row.onTimeStatus),
			].join(SEP),
		),
	];

	if (includeProvenance) {
		lines.push(
			buildProvenanceFooter({
				policy: 'logged',
				period: period ?? '',
				provenance,
				omitMissingVersion: true,
			}),
		);
	}

	return lines.join('\n');
}

/**
 * Build a real single-sheet `.xlsx` of the completeness report. Numbers stay
 * numeric so Excel can sum/sort them; the header is the first row.
 */
export function buildTeamCompletenessWorkbook(
	members: TeamMemberSummary[],
): Uint8Array {
	const rows = buildTeamCompletenessRows(members);
	const sheet: XlsxRow[] = [
		[...COLUMNS],
		...rows.map(
			(row): XlsxRow => [
				row.displayName,
				row.email,
				row.expectedHours,
				row.loggedHours,
				row.completenessPct,
				row.onTimeStatus,
			],
		),
	];
	return buildXlsx('Completeness', sheet);
}
