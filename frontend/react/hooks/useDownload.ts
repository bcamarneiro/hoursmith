import type { EnrichedJiraWorklog, GroupedWorklogs } from '../../../types/jira';
import type { UserAbsenceDays } from '../../services/absenceService';
import { useConfigStore } from '../../stores/useConfigStore';
import {
	type AggregationPolicy,
	buildSummaryCsv,
	buildTimesheetCsv,
	buildTimesheetFilename,
	download,
	type UserSummary,
} from '../utils/csv';
import { sanitizeFilename } from '../utils/downloadFile';
import { classifyWorklog } from '../utils/worklogClassifier';

export function formatMonthlyExportSegment(
	year: number,
	monthZeroIndexed: number,
): string {
	return `${year}-${String(monthZeroIndexed + 1).padStart(2, '0')}`;
}

function flattenUserWorklogs(
	userWorklogs: Record<string, EnrichedJiraWorklog[]>,
): EnrichedJiraWorklog[] {
	const out: EnrichedJiraWorklog[] = [];
	for (const list of Object.values(userWorklogs)) {
		out.push(...list);
	}
	return out;
}

function computeUserSummary(
	user: string,
	worklogs: EnrichedJiraWorklog[],
	policy: AggregationPolicy,
	period: { year: number; month: number },
): UserSummary {
	const expected = `${period.year}-${String(period.month + 1).padStart(2, '0')}`;
	let totalSeconds = 0;
	let backdatedSeconds = 0;
	let worklogCount = 0;
	let backdatedCount = 0;

	for (const wl of worklogs) {
		const c = classifyWorklog(wl);
		const key = policy === 'logged' ? c.loggedOn : c.intendedFor;
		if (!key.startsWith(expected)) continue;
		const seconds = wl.timeSpentSeconds ?? 0;
		totalSeconds += seconds;
		worklogCount++;
		if (c.isBackdated) {
			backdatedSeconds += seconds;
			backdatedCount++;
		}
	}

	const totalHours = totalSeconds / 3600;
	return {
		user,
		totalHours,
		backdatedHours: backdatedSeconds / 3600,
		worklogCount,
		backdatedCount,
		daysWorked: totalHours / 8,
	};
}

const DEFAULT_POLICY: AggregationPolicy = 'logged';

export function useDownload(opts?: {
	absenceDaysByUser?: UserAbsenceDays;
	userEmails?: Record<string, string>;
}) {
	const jiraHost = useConfigStore((state) => state.config.jiraHost);
	const includeAbsenceInCsv = useConfigStore(
		(state) => state.config.includeAbsenceInCsv,
	);
	const includeCsvProvenance = useConfigStore(
		(state) => state.config.includeCsvProvenance,
	);

	const provenance = { jiraHost: jiraHost || 'unknown' };

	const resolveAbsenceMap = (user: string) =>
		opts?.absenceDaysByUser?.get(opts.userEmails?.[user] ?? '') ?? undefined;

	const downloadUser = (
		user: string,
		grouped: GroupedWorklogs,
		issueSummaries: Record<string, string>,
		year: number,
		month: number,
		policy: AggregationPolicy = DEFAULT_POLICY,
	) => {
		const worklogs = flattenUserWorklogs(grouped[user] || {});
		const csvContent = buildTimesheetCsv({
			worklogs,
			issueSummaries,
			policy,
			period: { year, month },
			provenance,
			includeProvenance: includeCsvProvenance,
			absenceDays: resolveAbsenceMap(user),
			includeAbsenceColumns: includeAbsenceInCsv,
		});
		download(buildTimesheetFilename(user, policy, { year, month }), csvContent);
	};

	const downloadAll = (
		users: string[],
		grouped: GroupedWorklogs,
		issueSummaries: Record<string, string>,
		year: number,
		month: number,
		policy: AggregationPolicy = DEFAULT_POLICY,
	) => {
		const summaries: UserSummary[] = [];

		for (const user of users) {
			const worklogs = flattenUserWorklogs(grouped[user] || {});
			const csvContent = buildTimesheetCsv({
				worklogs,
				issueSummaries,
				policy,
				period: { year, month },
				provenance,
				includeProvenance: includeCsvProvenance,
				absenceDays: resolveAbsenceMap(user),
				includeAbsenceColumns: includeAbsenceInCsv,
			});
			download(
				buildTimesheetFilename(user, policy, { year, month }),
				csvContent,
			);
			summaries.push(
				computeUserSummary(user, worklogs, policy, { year, month }),
			);
		}

		if (users.length > 1) {
			const summaryCsv = buildSummaryCsv({
				summaries,
				policy,
				period: { year, month },
				provenance,
				includeProvenance: includeCsvProvenance,
			});
			const segment = formatMonthlyExportSegment(year, month);
			download(
				sanitizeFilename(`summary-${segment}-${policy}.csv`),
				summaryCsv,
			);
		}
	};

	return { downloadUser, downloadAll };
}
