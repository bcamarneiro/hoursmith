import { Link } from 'react-router-dom';
import type { WorklogFetchProgress } from '../../../../types/worklogLoading';
import type { TeamMemberSummary } from '../../../services/teamService';
import type {
	ReportsSortDirection,
	ReportsSortField,
} from '../../hooks/useReportsURLState';
import * as styles from '../../pages/ReportsPage.module.css';
import { addDaysToIsoDate, parseIsoDateLocal } from '../../utils/date';
import { formatHours } from '../../utils/format';
import type { ManagerTrendModel } from '../../utils/teamReports';
import { TeamStatsCards } from '../team/TeamStatsCards';
import { ProgressBar } from '../ui/ProgressBar';
import { WorklogLoadingStatus } from '../ui/WorklogLoadingStatus';
import { ManagerInsightsPanel } from './ManagerInsightsPanel';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// Per-day cells stay neutral mono — the Gap column is the single red signal on
// this table (screens.html: "only the gap cell goes red"). Per-day fullness is
// read from the figure itself, not a colour wash.
const gapCellStyleMap = {
	positive: styles.gapPositive,
	zero: styles.gapZero,
} as const;

function getGapCellStyle(gapSeconds: number): string {
	return gapSeconds > 0 ? gapCellStyleMap.positive : gapCellStyleMap.zero;
}

function getWeekdays(weekStart: string): string[] {
	return Array.from({ length: 5 }, (_, index) =>
		addDaysToIsoDate(weekStart, index),
	);
}

function formatDayHeader(dateStr: string, index: number): string {
	const d = parseIsoDateLocal(dateStr);
	return `${DAY_LABELS[index]} ${d.getDate()}`;
}

function formatHoursDecimal(hours: number): string {
	return Number.isInteger(hours)
		? `${hours.toFixed(0)}h`
		: `${hours.toFixed(1)}h`;
}

// Compliance banner copy is derived from the members' actual targets — the
// figure must reflect part-time/prorated targets and short weeks, never a
// hardcoded 40h. When every rendered member shares the same target we can name
// the hours; when targets differ we fall back to neutral, number-free copy.
function getComplianceMessage(members: TeamMemberSummary[]): string {
	const targets = members.map((m) => m.targetSeconds);
	const allShareTarget = targets.every((t) => t === targets[0]);
	if (allShareTarget && targets[0] > 0) {
		const target = formatHours(targets[0]);
		return members.length === 1
			? `The team member has logged ${target}+ this week.`
			: `Every team member has logged ${target}+ this week.`;
	}
	return members.length === 1
		? 'The team member hit their logging target this week.'
		: 'Every team member hit their logging target this week.';
}

function TeamMemberRow({
	member,
	weekdays,
	onMemberClick,
}: {
	member: TeamMemberSummary;
	weekdays: string[];
	onMemberClick: (name: string) => void;
}) {
	const pct = (member.totalSeconds / member.targetSeconds) * 100;
	const workedOnPto = member.workedOnPtoDates ?? [];

	return (
		<tr>
			<td>
				<button
					type="button"
					className={styles.memberNameButton}
					onClick={() => onMemberClick(member.displayName)}
				>
					{member.displayName}
				</button>
				{workedOnPto.length > 0 && (
					<span
						className={styles.workedOnPtoBadge}
						title={`Logged work on a PTO/holiday day: ${workedOnPto.join(', ')}`}
						aria-label={`Worked on time off: ${workedOnPto.join(', ')}`}
						role="img"
					>
						{' '}
						⚠
					</span>
				)}
				<div className={styles.memberEmail}>{member.email}</div>
				<div className={styles.rowProgress}>
					<ProgressBar value={pct} height={4} />
				</div>
			</td>
			{weekdays.map((day) => {
				const hours = member.dailyHours.get(day) || 0;
				return (
					<td key={day} className={styles.hoursCell}>
						{hours > 0 ? formatHoursDecimal(hours) : '-'}
					</td>
				);
			})}
			<td className={styles.totalCell}>{formatHours(member.totalSeconds)}</td>
			<td className={getGapCellStyle(member.gapSeconds)}>
				{member.gapSeconds > 0 ? formatHours(member.gapSeconds) : 'OK'}
			</td>
		</tr>
	);
}

function SummaryRow({
	members,
	weekdays,
}: {
	members: TeamMemberSummary[];
	weekdays: string[];
}) {
	if (members.length === 0) return null;

	const count = members.length;

	return (
		<tr className={styles.summaryRow}>
			<td>
				<span className={styles.summaryLabel}>Team Average</span>
				<span className={styles.memberCount}>
					{' '}
					({count} {count === 1 ? 'member' : 'members'})
				</span>
			</td>
			{weekdays.map((day) => {
				const avg =
					members.reduce((sum, m) => sum + (m.dailyHours.get(day) || 0), 0) /
					count;
				return (
					<td key={day} className={styles.hoursCell}>
						{avg > 0 ? formatHoursDecimal(avg) : '-'}
					</td>
				);
			})}
			<td className={styles.totalCell}>
				{formatHours(
					Math.round(
						members.reduce((sum, m) => sum + m.totalSeconds, 0) / count,
					),
				)}
			</td>
			<td className={styles.gapCell}>
				{formatHours(
					Math.round(members.reduce((sum, m) => sum + m.gapSeconds, 0) / count),
				)}
			</td>
		</tr>
	);
}

function SortIndicator({
	field,
	activeField,
	direction,
}: {
	field: ReportsSortField;
	activeField: ReportsSortField;
	direction: ReportsSortDirection;
}) {
	if (field !== activeField) return null;
	return (
		<span className={styles.sortIndicator}>
			{direction === 'asc' ? '▲' : '▼'}
		</span>
	);
}

type Props = {
	teamMembers: TeamMemberSummary[];
	sortedMembers: TeamMemberSummary[];
	weekStart: string;
	weekLoading: boolean;
	weekFetching: boolean;
	teamError: Error | null;
	teamLoadingProgress: WorklogFetchProgress | null;
	sortField: ReportsSortField;
	sortDirection: ReportsSortDirection;
	onSort: (field: ReportsSortField) => void;
	managerMode: boolean;
	trendWeeks: number;
	setTrendWeeks: (n: number) => void;
	trendModel: ManagerTrendModel | undefined;
	trendsLoading: boolean;
	trendsError: unknown;
	hasNoFilteredWeeklyResults: boolean;
	weeklySummary: { totalSeconds: number; totalGapSeconds: number } | null;
	onMemberClick: (name: string) => void;
	/**
	 * True when Jira isn't connected yet (no host/API token). Shows a "connect
	 * Jira" guard instead of the misleading empty-team state, matching the
	 * monthly view's not-configured branch. Optional + defaults off so the demo
	 * (sample data, intentionally unconfigured) renders normally.
	 */
	notConfigured?: boolean;
};

export const ReportsWeeklyView: React.FC<Props> = ({
	teamMembers,
	sortedMembers,
	weekStart,
	weekLoading,
	teamError,
	teamLoadingProgress,
	sortField,
	sortDirection,
	onSort,
	managerMode,
	trendWeeks,
	setTrendWeeks,
	trendModel,
	trendsLoading,
	trendsError,
	hasNoFilteredWeeklyResults,
	weeklySummary,
	onMemberClick,
	notConfigured,
}) => {
	const weekdays = getWeekdays(weekStart);

	if (notConfigured) {
		return (
			<div className={styles.error}>
				<h2>Connect Jira to see reports</h2>
				<p>
					Add your Jira host and API token in Settings to load your team's
					weekly worklogs.
				</p>
				<Link to="/settings">Go to Settings</Link>
			</div>
		);
	}

	return (
		<>
			{weeklySummary && (
				<div className={styles.reportSummary}>
					<strong>Weekly Snapshot</strong>
					<span>
						{formatHours(weeklySummary.totalSeconds)} logged across the team
					</span>
					<span>
						{weeklySummary.totalGapSeconds > 0
							? `${formatHours(weeklySummary.totalGapSeconds)} remaining gap`
							: 'No team gap remaining'}
					</span>
				</div>
			)}
			{teamError && (
				<div className={styles.error}>
					<h2>Unable to load team data</h2>
					<p>{teamError.message}</p>
					<Link to="/settings">Check your settings</Link>
				</div>
			)}

			{weekLoading && teamMembers.length === 0 && (
				<div className={styles.loading}>
					<WorklogLoadingStatus
						title="Loading team worklogs"
						progress={teamLoadingProgress}
					/>
				</div>
			)}

			{!weekLoading && !teamError && teamMembers.length === 0 && (
				<div className={styles.emptyState}>
					<div className={styles.emptyIcon}>&#128203;</div>
					<div className={styles.emptyTitle}>No team data found</div>
					<div className={styles.emptyDescription}>
						No worklogs were found for this week. Make sure team members have
						logged time, or configure your team members list in Settings.
					</div>
				</div>
			)}

			{managerMode && teamMembers.length > 0 ? (
				<ManagerInsightsPanel
					trendWeeks={trendWeeks}
					onTrendWeeksChange={setTrendWeeks}
					currentMembers={teamMembers}
					model={trendModel}
					isLoading={trendsLoading}
					errorMessage={
						trendsError instanceof Error ? trendsError.message : undefined
					}
				/>
			) : null}

			{hasNoFilteredWeeklyResults && (
				<div className={styles.emptyState}>
					<div className={styles.emptyIcon}>&#128269;</div>
					<div className={styles.emptyTitle}>
						No team members match these filters
					</div>
					<div className={styles.emptyDescription}>
						Try clearing the people filter or disable attention-only mode to see
						the full weekly report again.
					</div>
				</div>
			)}

			{teamMembers.length > 0 && !hasNoFilteredWeeklyResults && (
				<>
					{weekLoading && (
						<div className={styles.refetching}>
							<WorklogLoadingStatus
								title="Updating team worklogs"
								progress={teamLoadingProgress}
								compact
							/>
						</div>
					)}
					<TeamStatsCards teamMembers={sortedMembers} />

					<div className={styles.tableWrapper}>
						<table className={styles.table}>
							<thead>
								<tr>
									<th className={styles.sortableHeader}>
										<button
											type="button"
											className={styles.sortButton}
											onClick={() => onSort('name')}
										>
											Team Member
											<SortIndicator
												field="name"
												activeField={sortField}
												direction={sortDirection}
											/>
										</button>
									</th>
									{weekdays.map((day, i) => (
										<th key={day} className={styles.dayHeader}>
											{formatDayHeader(day, i)}
										</th>
									))}
									<th
										className={`${styles.dayHeader} ${styles.sortableHeader}`}
									>
										<button
											type="button"
											className={styles.sortButton}
											onClick={() => onSort('total')}
										>
											Total
											<SortIndicator
												field="total"
												activeField={sortField}
												direction={sortDirection}
											/>
										</button>
									</th>
									<th
										className={`${styles.dayHeader} ${styles.sortableHeader}`}
									>
										<button
											type="button"
											className={styles.sortButton}
											onClick={() => onSort('gap')}
										>
											Gap
											<SortIndicator
												field="gap"
												activeField={sortField}
												direction={sortDirection}
											/>
										</button>
									</th>
								</tr>
							</thead>
							<tbody>
								{sortedMembers.map((member) => (
									<TeamMemberRow
										key={member.email}
										member={member}
										weekdays={weekdays}
										onMemberClick={onMemberClick}
									/>
								))}
								<SummaryRow members={sortedMembers} weekdays={weekdays} />
							</tbody>
						</table>
					</div>

					{sortedMembers.some((m) => m.targetSeconds > 0) &&
						sortedMembers.every((m) => m.gapSeconds === 0) && (
							<div className={styles.allCompliant}>
								<div className={styles.allCompliantIcon}>&#10003;</div>
								<div className={styles.allCompliantTitle}>
									Full team compliance!
								</div>
								<div className={styles.allCompliantText}>
									{getComplianceMessage(sortedMembers)}
								</div>
							</div>
						)}
				</>
			)}
		</>
	);
};
