import { Link } from 'react-router-dom';
import type { WorklogFetchProgress } from '../../../../types/worklogLoading';
import { isPremiumBuild } from '../../../buildTier';
import { describeServiceError } from '../../../services/serviceErrors';
import type { TeamMemberSummary } from '../../../services/teamService';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import { useReminderStateSync } from '../../hooks/useReminderStateSync';
import type {
	ReportsSortDirection,
	ReportsSortField,
} from '../../hooks/useReportsURLState';
import * as styles from '../../pages/ReportsPage.module.css';
import { addDaysToIsoDate, parseIsoDateLocal } from '../../utils/date';
import { formatHours } from '../../utils/format';
import { describeOnTimeStatus } from '../../utils/onTimeStatus';
import type { TeamCoverage } from '../../utils/teamCoverage';
import type { ManagerTrendModel } from '../../utils/teamReports';
import { TeamStatsCards } from '../team/TeamStatsCards';
import { Button } from '../ui/Button';
import { ProgressBar } from '../ui/ProgressBar';
import { WorklogLoadingStatus } from '../ui/WorklogLoadingStatus';
import { ManagerInsightsPanel } from './ManagerInsightsPanel';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// On-time status badge tone → CSS class (ADA-387). The ember brand accent is
// never used here — this rides the green/amber/red worklog ramp plus a neutral.
const ON_TIME_TONE_CLASS: Record<string, string> = {
	success: styles.onTimeSuccess,
	warning: styles.onTimeWarning,
	error: styles.onTimeError,
	neutral: styles.onTimeNeutral,
};

// Per-day cells stay neutral mono — the Gap column is the single red signal on
// this table (screens.html: "only the gap cell goes red"). Per-day fullness is
// read from the figure itself, not a colour wash.
//
// The cell always shows the full-week remaining figure, but it only turns RED
// when the member is behind *relative to elapsed days* (prorated gap > 0). A
// member on track mid-week still shows a remaining figure, in a neutral tone —
// no manufactured "you're behind" on Monday for Thursday's hours (ADA-477).
function getGapCellStyle(member: TeamMemberSummary): string {
	const behindSchedule = (member.proratedGapSeconds ?? member.gapSeconds) > 0;
	if (behindSchedule) return styles.gapPositive; // genuinely behind → red
	if (member.gapSeconds > 0) return styles.gapPending; // on track, week open → neutral
	return styles.gapZero; // fully complete → OK
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
	// Guard against a zero target (e.g. a full week of PTO) — a bare division
	// would feed NaN/Infinity into ProgressBar (ADA-458). No target → 0%.
	const pct =
		member.targetSeconds > 0
			? (member.totalSeconds / member.targetSeconds) * 100
			: 0;
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
				{member.onTimeStatus &&
					(() => {
						const { label, tone } = describeOnTimeStatus(member.onTimeStatus);
						return (
							<span
								className={`${styles.onTimeBadge} ${ON_TIME_TONE_CLASS[tone]}`}
							>
								{label}
							</span>
						);
					})()}
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
			<td className={getGapCellStyle(member)}>
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

// Coverage / visibility banner (ADA-488). Surfaces expected-vs-observed so a
// permission hole or a genuinely-absent 0h member never reads as "all clear".
// Rides the amber warning tone (never the ember brand accent).
function TeamCoverageBanner({ coverage }: { coverage: TeamCoverage }) {
	if (!coverage.rosterConfigured) {
		return (
			<div
				className={`${styles.coverageBanner} ${styles.coverageBannerWarning}`}
			>
				<strong>No team roster set</strong>
				<span>
					This board is built only from people who logged time, so anyone who
					logged nothing this week won't appear here. Add your team in{' '}
					<Link to="/settings">Settings</Link> to track 0h members too.
				</span>
			</div>
		);
	}
	if (coverage.noWorklogCount > 0) {
		const { rosterSize, loggedCount, noWorklogCount } = coverage;
		return (
			<div
				className={`${styles.coverageBanner} ${styles.coverageBannerWarning}`}
			>
				<strong>
					Roster {rosterSize} · logged {loggedCount} · no worklogs{' '}
					{noWorklogCount}
				</strong>
				<span>
					{noWorklogCount} roster{' '}
					{noWorklogCount === 1 ? 'member has' : 'members have'} nothing logged
					this week — shown in red below. A 0h row can mean they're behind or
					that your token can't see their work, so nothing is silently dropped.
				</span>
			</div>
		);
	}
	return (
		<div className={`${styles.coverageBanner} ${styles.coverageBannerOk}`}>
			<strong>Full roster coverage</strong>
			<span>
				All {coverage.rosterSize} roster members logged time this week.
			</span>
		</div>
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
	/** Roster-vs-observed coverage for the visibility banner (ADA-488). */
	coverage?: TeamCoverage;
	/** Re-runs the weekly team fetch from the data-error surface (ADA-476). */
	onRetry?: () => void;
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
	coverage,
	onRetry,
	onMemberClick,
	notConfigured,
}) => {
	const weekdays = getWeekdays(weekStart);

	// Keep the server's reminder state fresh from what the lead sees here, so the
	// cron can chase behind members (ADA-552). Dark until the `reminders-ui` flag
	// is on and the lead has opted in; a no-op in the Free build.
	const remindersUiFlag = useFeatureFlag('reminders-ui');
	useReminderStateSync(
		teamMembers,
		weekStart,
		isPremiumBuild() && remindersUiFlag && !weekLoading,
	);

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
			{coverage && !weekLoading && !teamError && teamMembers.length > 0 && (
				<TeamCoverageBanner coverage={coverage} />
			)}
			{teamError &&
				(() => {
					// Route the error through the shared mapper so a Hoursmith-session
					// 401 reads as "sign in again" rather than "check Jira" (ADA-475),
					// and surface a "Try again" refetch alongside the link (ADA-476).
					const copy = describeServiceError(teamError);
					return (
						<div className={styles.error}>
							<h2>Unable to load team data</h2>
							<p>{copy.message}</p>
							{onRetry && (
								<p>
									<Button variant="secondary" onClick={onRetry}>
										Try again
									</Button>
								</p>
							)}
							<Link to={copy.action?.to ?? '/settings'}>
								{copy.action?.label ?? 'Check your settings'}
							</Link>
						</div>
					);
				})()}

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
