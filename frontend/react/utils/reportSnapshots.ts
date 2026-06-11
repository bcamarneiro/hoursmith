import type { EnrichedJiraWorklog } from '../../../types/jira';
import type { TeamMemberSummary } from '../../services/teamService';
import {
	getWorkingDaysInMonth,
	isDateInMonth,
	parseIsoDateLocal,
} from './date';
import { formatHours } from './format';
import type { ManagerTrendModel } from './teamReports';
import { classifyWorklog } from './worklogClassifier';

type SnapshotValidationState = {
	status: string;
	message: string;
	checkedAt: string | null;
};

type WeeklySnapshotInput = {
	viewMode: 'weekly';
	jiraHost: string;
	weekStart: string;
	weekEnd: string;
	searchQuery: string;
	onlyAttentionNeeded: boolean;
	managerMode: boolean;
	trendWeeks: number;
	sortField: 'name' | 'total' | 'gap';
	sortDirection: 'asc' | 'desc';
	members: TeamMemberSummary[];
	validationState: SnapshotValidationState;
	trendModel?: ManagerTrendModel;
};

type MonthlySnapshotInput = {
	viewMode: 'monthly';
	jiraHost: string;
	monthLabel: string;
	year: number;
	monthZeroIndexed: number;
	searchQuery: string;
	selectedUser: string;
	entries: [string, Record<string, EnrichedJiraWorklog[]>][];
};

export type ReportsSnapshotInput = WeeklySnapshotInput | MonthlySnapshotInput;

type MonthlyUserRow = {
	user: string;
	totalSeconds: number;
	entryCount: number;
	activeDays: number;
};

type DailyBreakdownRow = {
	date: string;
	entries: number;
	totalSeconds: number;
};

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function formatDateLabel(dateStr: string): string {
	const date = parseIsoDateLocal(dateStr);
	return date.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
	});
}

function summarizeMonthlyEntries(
	entries: [string, Record<string, EnrichedJiraWorklog[]>][],
	year: number,
	monthZeroIndexed: number,
): MonthlyUserRow[] {
	return entries
		.map(([user, days]) => {
			let totalSeconds = 0;
			let entryCount = 0;
			const activeDaySet = new Set<string>();

			// The outer date key is already `classifyWorklog(wl).loggedOn`
			// (ADA-219). Backdated entries are excluded from totals — they
			// surface as ghosts / side notes only. CSV exports remain
			// inclusive (see `csv.ts`).
			for (const [dateKey, worklogs] of Object.entries(days)) {
				if (!dateKey) continue;
				if (!isDateInMonth(dateKey, year, monthZeroIndexed)) continue;
				for (const worklog of worklogs) {
					if (classifyWorklog(worklog).isBackdated) continue;
					totalSeconds += worklog.timeSpentSeconds ?? 0;
					entryCount += 1;
					activeDaySet.add(dateKey);
				}
			}

			return {
				user,
				totalSeconds,
				entryCount,
				activeDays: activeDaySet.size,
			};
		})
		.sort((a, b) => {
			if (b.totalSeconds !== a.totalSeconds) {
				return b.totalSeconds - a.totalSeconds;
			}
			return a.user.localeCompare(b.user);
		});
}

function buildDailyBreakdown(
	entry: [string, Record<string, EnrichedJiraWorklog[]>] | undefined,
	year: number,
	monthZeroIndexed: number,
): DailyBreakdownRow[] {
	if (!entry) return [];

	// Outer key is `loggedOn` (ADA-219). Backdated entries are excluded so
	// the breakdown matches the per-day totals shown in the calendar.
	const buckets = new Map<string, { entries: number; totalSeconds: number }>();
	for (const [dateKey, worklogs] of Object.entries(entry[1])) {
		if (!dateKey) continue;
		if (!isDateInMonth(dateKey, year, monthZeroIndexed)) continue;
		for (const worklog of worklogs) {
			if (classifyWorklog(worklog).isBackdated) continue;
			const bucket = buckets.get(dateKey) ?? {
				entries: 0,
				totalSeconds: 0,
			};
			bucket.entries += 1;
			bucket.totalSeconds += worklog.timeSpentSeconds ?? 0;
			buckets.set(dateKey, bucket);
		}
	}

	return [...buckets.entries()]
		.map(([date, value]) => ({
			date,
			entries: value.entries,
			totalSeconds: value.totalSeconds,
		}))
		.sort((a, b) => a.date.localeCompare(b.date));
}

function buildHeaderSummary(input: ReportsSnapshotInput): string[] {
	const lines = ['# Hoursmith Report Snapshot', ''];
	lines.push(`Source: ${input.jiraHost || 'Unconfigured Jira host'}`);

	if (input.viewMode === 'weekly') {
		lines.push(`View: Weekly (${input.weekStart} to ${input.weekEnd})`);
		lines.push(`Sort: ${input.sortField} (${input.sortDirection})`);
		lines.push(
			`Filters: ${input.searchQuery || 'none'}${input.onlyAttentionNeeded ? ', attention-only' : ''}${input.managerMode ? `, manager mode (${input.trendWeeks} weeks)` : ''}`,
		);
	} else {
		lines.push(`View: Monthly (${input.monthLabel})`);
		lines.push(`Filters: ${input.searchQuery || 'none'}`);
		if (input.selectedUser) {
			lines.push(`Selected user: ${input.selectedUser}`);
		}
	}

	lines.push('');
	return lines;
}

export function buildReportsSnapshotMarkdown(
	input: ReportsSnapshotInput,
): string {
	const lines = buildHeaderSummary(input);

	if (input.viewMode === 'weekly') {
		const totalSeconds = input.members.reduce(
			(sum, member) => sum + member.totalSeconds,
			0,
		);
		const totalGapSeconds = input.members.reduce(
			(sum, member) => sum + member.gapSeconds,
			0,
		);
		lines.push(`Team members: ${input.members.length}`);
		lines.push(`Team total: ${formatHours(totalSeconds)}`);
		lines.push(`Open gap: ${formatHours(totalGapSeconds)}`);
		lines.push(
			`Validation: ${input.validationState.status} (${input.validationState.message})`,
		);
		if (input.validationState.checkedAt) {
			lines.push(`Checked at: ${input.validationState.checkedAt}`);
		}
		lines.push('');
		lines.push('| Member | Email | Total | Gap |');
		lines.push('| --- | --- | ---: | ---: |');
		for (const member of input.members) {
			lines.push(
				`| ${member.displayName} | ${member.email} | ${formatHours(member.totalSeconds)} | ${formatHours(member.gapSeconds)} |`,
			);
		}

		if (input.managerMode && input.trendModel) {
			lines.push('');
			lines.push(`## ${input.trendWeeks}-Week Trend`);
			for (const week of input.trendModel.weeks) {
				lines.push(
					`- ${week.weekStart}: ${week.complianceRate}% compliant, ${formatHours(week.totalGapSeconds)} gap, ${week.attentionCount} people need attention`,
				);
			}

			if (input.trendModel.recurringGapMembers.length > 0) {
				lines.push('');
				lines.push('## Recurring Gap Watchlist');
				for (const member of input.trendModel.recurringGapMembers.slice(0, 5)) {
					lines.push(
						`- ${member.displayName}: ${member.gapWeeks} weeks with gap, current ${formatHours(member.currentGapSeconds)}, average ${formatHours(member.averageGapSeconds)}`,
					);
				}
			}
		}

		return lines.join('\n');
	}

	const userRows = summarizeMonthlyEntries(
		input.entries,
		input.year,
		input.monthZeroIndexed,
	);
	const totalSeconds = userRows.reduce((sum, row) => sum + row.totalSeconds, 0);
	lines.push(`Visible users: ${userRows.length}`);
	lines.push(`Month total: ${formatHours(totalSeconds)}`);
	lines.push(
		`Working days in month: ${getWorkingDaysInMonth(input.year, input.monthZeroIndexed)}`,
	);
	lines.push('');
	lines.push('| User | Total | Entries | Active days |');
	lines.push('| --- | ---: | ---: | ---: |');
	for (const row of userRows) {
		lines.push(
			`| ${row.user} | ${formatHours(row.totalSeconds)} | ${row.entryCount} | ${row.activeDays} |`,
		);
	}

	const detailedEntry = input.selectedUser
		? input.entries.find(([user]) => user === input.selectedUser)
		: input.entries.length === 1
			? input.entries[0]
			: undefined;
	const breakdown = buildDailyBreakdown(
		detailedEntry,
		input.year,
		input.monthZeroIndexed,
	);
	if (detailedEntry && breakdown.length > 0) {
		lines.push('');
		lines.push(`## Daily breakdown for ${detailedEntry[0]}`);
		for (const day of breakdown) {
			lines.push(
				`- ${day.date}: ${formatHours(day.totalSeconds)} across ${day.entries} entr${day.entries === 1 ? 'y' : 'ies'}`,
			);
		}
	}

	return lines.join('\n');
}

export function buildReportsSnapshotHtml(input: ReportsSnapshotInput): string {
	const metadataRows =
		input.viewMode === 'weekly'
			? `
				<li><strong>View:</strong> Weekly (${escapeHtml(input.weekStart)} to ${escapeHtml(input.weekEnd)})</li>
				<li><strong>Sort:</strong> ${escapeHtml(input.sortField)} (${escapeHtml(input.sortDirection)})</li>
				<li><strong>Filters:</strong> ${escapeHtml(input.searchQuery || 'none')}${input.onlyAttentionNeeded ? ', attention-only' : ''}${input.managerMode ? `, manager mode (${input.trendWeeks} weeks)` : ''}</li>
			`
			: `
				<li><strong>View:</strong> Monthly (${escapeHtml(input.monthLabel)})</li>
				<li><strong>Filters:</strong> ${escapeHtml(input.searchQuery || 'none')}</li>
				${input.selectedUser ? `<li><strong>Selected user:</strong> ${escapeHtml(input.selectedUser)}</li>` : ''}
			`;

	const weeklySections =
		input.viewMode === 'weekly'
			? (() => {
					const totalSeconds = input.members.reduce(
						(sum, member) => sum + member.totalSeconds,
						0,
					);
					const totalGapSeconds = input.members.reduce(
						(sum, member) => sum + member.gapSeconds,
						0,
					);
					const trends =
						input.managerMode && input.trendModel
							? `
								<section>
									<h2>${input.trendWeeks}-Week Trend</h2>
									<ul>
										${input.trendModel.weeks
											.map(
												(week) =>
													`<li><strong>${escapeHtml(week.weekStart)}</strong>: ${week.complianceRate}% compliant, ${escapeHtml(formatHours(week.totalGapSeconds))} gap, ${week.attentionCount} people need attention</li>`,
											)
											.join('')}
									</ul>
									${
										input.trendModel.recurringGapMembers.length > 0
											? `<h3>Recurring Gap Watchlist</h3>
												<ul>
													${input.trendModel.recurringGapMembers
														.slice(0, 5)
														.map(
															(member) =>
																`<li><strong>${escapeHtml(member.displayName)}</strong>: ${member.gapWeeks} weeks with gap, current ${escapeHtml(formatHours(member.currentGapSeconds))}, average ${escapeHtml(formatHours(member.averageGapSeconds))}</li>`,
														)
														.join('')}
												</ul>`
											: ''
									}
								</section>
							`
							: '';

					return `
						<section class="summary-grid">
							<div class="stat"><span>Team members</span><strong>${input.members.length}</strong></div>
							<div class="stat"><span>Team total</span><strong>${escapeHtml(formatHours(totalSeconds))}</strong></div>
							<div class="stat"><span>Open gap</span><strong>${escapeHtml(formatHours(totalGapSeconds))}</strong></div>
						</section>
						<section>
							<h2>Validation</h2>
							<p><strong>${escapeHtml(input.validationState.status)}</strong> ${escapeHtml(input.validationState.message)}</p>
							${
								input.validationState.checkedAt
									? `<p>Checked at: ${escapeHtml(input.validationState.checkedAt)}</p>`
									: ''
							}
						</section>
						<section>
							<h2>Visible Team Table</h2>
							<table>
								<thead>
									<tr><th>Member</th><th>Email</th><th>Total</th><th>Gap</th></tr>
								</thead>
								<tbody>
									${input.members
										.map(
											(member) => `
												<tr>
													<td>${escapeHtml(member.displayName)}</td>
													<td>${escapeHtml(member.email)}</td>
													<td>${escapeHtml(formatHours(member.totalSeconds))}</td>
													<td>${escapeHtml(formatHours(member.gapSeconds))}</td>
												</tr>
											`,
										)
										.join('')}
								</tbody>
							</table>
						</section>
						${trends}
					`;
				})()
			: (() => {
					const userRows = summarizeMonthlyEntries(
						input.entries,
						input.year,
						input.monthZeroIndexed,
					);
					const totalSeconds = userRows.reduce(
						(sum, row) => sum + row.totalSeconds,
						0,
					);
					const detailedEntry = input.selectedUser
						? input.entries.find(([user]) => user === input.selectedUser)
						: input.entries.length === 1
							? input.entries[0]
							: undefined;
					const breakdown = buildDailyBreakdown(
						detailedEntry,
						input.year,
						input.monthZeroIndexed,
					);

					return `
						<section class="summary-grid">
							<div class="stat"><span>Visible users</span><strong>${userRows.length}</strong></div>
							<div class="stat"><span>Month total</span><strong>${escapeHtml(formatHours(totalSeconds))}</strong></div>
							<div class="stat"><span>Working days</span><strong>${getWorkingDaysInMonth(input.year, input.monthZeroIndexed)}</strong></div>
						</section>
						<section>
							<h2>Monthly Overview</h2>
							<table>
								<thead>
									<tr><th>User</th><th>Total</th><th>Entries</th><th>Active days</th></tr>
								</thead>
								<tbody>
									${userRows
										.map(
											(row) => `
												<tr>
													<td>${escapeHtml(row.user)}</td>
													<td>${escapeHtml(formatHours(row.totalSeconds))}</td>
													<td>${row.entryCount}</td>
													<td>${row.activeDays}</td>
												</tr>
											`,
										)
										.join('')}
								</tbody>
							</table>
						</section>
						${
							detailedEntry && breakdown.length > 0
								? `
									<section>
										<h2>Daily Breakdown for ${escapeHtml(detailedEntry[0])}</h2>
										<table>
											<thead>
												<tr><th>Date</th><th>Label</th><th>Total</th><th>Entries</th></tr>
											</thead>
											<tbody>
												${breakdown
													.map(
														(day) => `
															<tr>
																<td>${escapeHtml(day.date)}</td>
																<td>${escapeHtml(formatDateLabel(day.date))}</td>
																<td>${escapeHtml(formatHours(day.totalSeconds))}</td>
																<td>${day.entries}</td>
															</tr>
														`,
													)
													.join('')}
											</tbody>
										</table>
									</section>
								`
								: ''
						}
					`;
				})();

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Hoursmith Report Snapshot</title>
	<style>
		body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 32px; background: #f4efe7; color: #241d18; }
		main { max-width: 1080px; margin: 0 auto; display: grid; gap: 24px; }
		header, section { background: #fbf8f2; border: 1px solid #e2d8c8; border-radius: 16px; padding: 24px; }
		h1, h2, h3 { margin: 0 0 12px; }
		p, li { line-height: 1.5; }
		ul { margin: 0; padding-left: 20px; }
		.summary-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
		.stat { border: 1px solid #e2d8c8; border-radius: 12px; padding: 16px; background: #ede4d6; }
		.stat span { display: block; color: #574d43; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; }
		.stat strong { font-size: 24px; }
		table { width: 100%; border-collapse: collapse; }
		th, td { padding: 12px 14px; border-bottom: 1px solid #e2d8c8; text-align: left; }
		th { background: #ede4d6; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #574d43; }
		.meta-list { display: grid; gap: 8px; }
	</style>
</head>
<body>
	<main>
		<header>
			<h1>Hoursmith Report Snapshot</h1>
			<p>Read-only export generated from the current Reports view.</p>
			<ul class="meta-list">
				<li><strong>Source:</strong> ${escapeHtml(input.jiraHost || 'Unconfigured Jira host')}</li>
				${metadataRows}
			</ul>
		</header>
		${weeklySections}
	</main>
</body>
</html>`;
}
