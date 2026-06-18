import type { TeamMemberSummary } from '../../services/teamService';
import { buildProvenanceFooter, csvEscape, CSV_SEP as SEP } from './csvHelpers';
import { parseIsoDateLocal } from './date';
import { BASELINE_DAY_SECONDS } from './dayTarget';

function formatDayLabel(dateStr: string): string {
	const d = parseIsoDateLocal(dateStr);
	const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	return `${days[d.getDay()]} ${d.getDate()}`;
}

/**
 * Provenance metadata appended as a `# generated=…` footer line, mirroring
 * the finance-grade per-user CSV exporters.
 */
export interface TeamCsvProvenance {
	jiraHost?: string;
	sourceVersion?: string;
	generatedAt?: string;
}

export interface BuildTeamCsvOptions {
	provenance?: TeamCsvProvenance;
	/** Append the `# generated=…` provenance footer line. Default true. */
	includeProvenance?: boolean;
	/** Adds an "Absence (h)" column showing how much each member's target was
	 *  reduced for PTO/holidays in the period. Off by default. */
	includeAbsenceColumns?: boolean;
}

export function buildTeamCsv(
	members: TeamMemberSummary[],
	weekdays: string[],
	provenanceOrOptions?: TeamCsvProvenance | BuildTeamCsvOptions,
): string {
	// Legacy callers pass a bare provenance object; new callers an options
	// object. Same discriminator pattern as `generateWeeklyCsv`.
	const isOptionsShape =
		provenanceOrOptions !== undefined &&
		('provenance' in provenanceOrOptions ||
			'includeProvenance' in provenanceOrOptions ||
			'includeAbsenceColumns' in provenanceOrOptions);
	const opts: BuildTeamCsvOptions = isOptionsShape
		? (provenanceOrOptions as BuildTeamCsvOptions)
		: { provenance: provenanceOrOptions as TeamCsvProvenance | undefined };
	const {
		provenance,
		includeProvenance = true,
		includeAbsenceColumns = false,
	} = opts;

	const dayHeaders = weekdays.map(formatDayLabel);

	const headers = [
		'Team Member',
		'Email',
		...dayHeaders,
		'Total (h)',
		'Backdated (h)',
		'Gap (h)',
		...(includeAbsenceColumns ? ['Absence (h)'] : []),
	].join(SEP);

	// Per-member absence-target reduction: weekdays × 8h baseline minus
	// the actual target (which ADA-236 already discounted for PTO).
	const baselineSeconds = weekdays.length * BASELINE_DAY_SECONDS;
	const computeAbsenceHours = (m: TeamMemberSummary) =>
		Math.max(0, baselineSeconds - m.targetSeconds) / 3600;

	const rows = members.map((m) => {
		const dailyCells = weekdays.map((day) => {
			const hours = m.dailyHours.get(day) || 0;
			return hours > 0 ? hours.toFixed(1) : '0';
		});

		const backdatedHours = ((m.backdatedSeconds ?? 0) / 3600).toFixed(1);

		return [
			csvEscape(m.displayName),
			csvEscape(m.email),
			...dailyCells,
			(m.totalSeconds / 3600).toFixed(1),
			backdatedHours,
			(m.gapSeconds / 3600).toFixed(1),
			...(includeAbsenceColumns ? [computeAbsenceHours(m).toFixed(1)] : []),
		].join(SEP);
	});

	// Team average row
	const count = members.length;
	if (count > 0) {
		const avgCells = weekdays.map((day) => {
			const avg =
				members.reduce((sum, m) => sum + (m.dailyHours.get(day) || 0), 0) /
				count;
			return avg > 0 ? avg.toFixed(1) : '0';
		});
		const avgTotal =
			members.reduce((sum, m) => sum + m.totalSeconds, 0) / count / 3600;
		const avgBackdated =
			members.reduce((sum, m) => sum + (m.backdatedSeconds ?? 0), 0) /
			count /
			3600;
		const avgGap =
			members.reduce((sum, m) => sum + m.gapSeconds, 0) / count / 3600;

		const avgAbsence =
			members.reduce((sum, m) => sum + computeAbsenceHours(m), 0) / count;

		rows.push(
			[
				'Team Average',
				'',
				...avgCells,
				avgTotal.toFixed(1),
				avgBackdated.toFixed(1),
				avgGap.toFixed(1),
				...(includeAbsenceColumns ? [avgAbsence.toFixed(1)] : []),
			].join(SEP),
		);
	}

	const lines = [headers, ...rows];
	if (includeProvenance) {
		const periodStart = weekdays[0] ?? '';
		const periodEnd = weekdays[weekdays.length - 1] ?? '';
		lines.push(
			buildProvenanceFooter({
				policy: 'logged',
				period: `${periodStart}..${periodEnd}`,
				provenance,
				omitMissingVersion: true,
			}),
		);
	}
	return lines.join('\n');
}
