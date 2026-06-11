import { Link } from 'react-router-dom';
import type { EnrichedJiraWorklog } from '../../../../types/jira';
import type { WorklogFetchProgress } from '../../../../types/worklogLoading';
import type { UserAbsenceDays } from '../../../services/absenceService';
import * as styles from '../../pages/ReportsPage.module.css';
import { getUserAbsenceDayMap } from '../../utils/absence';
import { monthLabel } from '../../utils/date';
import { formatHours } from '../../utils/format';
import { OverviewTable } from '../OverviewTable';
import { TimesheetGrid } from '../TimesheetGrid';
import { TimesheetStatsCards } from '../timesheet/TimesheetStatsCards';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { WorklogLoadingStatus } from '../ui/WorklogLoadingStatus';

type MonthlyEntry = [string, Record<string, EnrichedJiraWorklog[]>];

type Props = {
	filteredVisibleEntries: MonthlyEntry[];
	selectedUser: string;
	isValidUser: boolean;
	selectedEntry: Record<string, EnrichedJiraWorklog[]> | undefined;
	userEmails: Record<string, string>;
	issueSummaries: Record<string, string>;
	monthlyAbsenceDaysByUser: UserAbsenceDays | undefined;
	currentYear: number;
	currentMonth: number;
	isLoading: boolean;
	hasData: boolean;
	hasNoData: boolean;
	hasNoFilteredMonthlyResults: boolean;
	monthlyWorklogProgress: WorklogFetchProgress | null;
	monthlySummary: { userCount: number; totalSeconds: number } | null;
	errorMessage: string | null | undefined;
	onUserChange: (user: string) => void;
	onDownloadUser: (user: string) => void;
};

export const ReportsMonthlyView: React.FC<Props> = ({
	filteredVisibleEntries,
	selectedUser,
	isValidUser,
	selectedEntry,
	userEmails,
	issueSummaries,
	monthlyAbsenceDaysByUser,
	currentYear,
	currentMonth,
	isLoading,
	hasData,
	hasNoData,
	hasNoFilteredMonthlyResults,
	monthlyWorklogProgress,
	monthlySummary,
	errorMessage,
	onUserChange,
	onDownloadUser,
}) => {
	if (errorMessage) {
		return (
			<div className={styles.error}>
				<h2>Unable to load timesheets</h2>
				<p>{errorMessage}</p>
				{errorMessage.includes('configured') ? (
					<Link to="/settings">Go to Settings</Link>
				) : errorMessage.includes('401') || errorMessage.includes('403') ? (
					<Link to="/settings">Check your credentials in Settings</Link>
				) : (
					<p>
						Try refreshing the page or check your{' '}
						<Link to="/settings">connection settings</Link>.
					</p>
				)}
			</div>
		);
	}

	return (
		<>
			{monthlySummary && !hasNoData && (
				<div className={styles.reportSummary}>
					<strong>Monthly Snapshot</strong>
					<span>
						{formatHours(monthlySummary.totalSeconds)} logged in{' '}
						{monthLabel(currentYear, currentMonth)}
					</span>
					<span>
						{isValidUser
							? `Filtered to ${selectedUser}`
							: `${monthlySummary.userCount} user${monthlySummary.userCount === 1 ? '' : 's'} in view`}
					</span>
				</div>
			)}
			{isLoading && !hasData && (
				<div className={styles.loading}>
					<WorklogLoadingStatus
						title="Loading worklogs"
						progress={monthlyWorklogProgress}
					/>
				</div>
			)}

			{isLoading && hasData && (
				<div className={styles.refetching}>
					<WorklogLoadingStatus
						title="Updating worklogs"
						progress={monthlyWorklogProgress}
						compact
					/>
				</div>
			)}

			{hasNoData && (
				<div className={styles.emptyState}>
					<div className={styles.emptyIcon}>&#128203;</div>
					<div className={styles.emptyTitle}>No worklogs found</div>
					<div className={styles.emptyDescription}>
						No worklogs were recorded for{' '}
						{monthLabel(currentYear, currentMonth)}. Try a different month or
						adjust your filters.
					</div>
				</div>
			)}

			{hasNoFilteredMonthlyResults && (
				<div className={styles.emptyState}>
					<div className={styles.emptyIcon}>&#128269;</div>
					<div className={styles.emptyTitle}>
						No monthly users match this filter
					</div>
					<div className={styles.emptyDescription}>
						Try clearing the people filter or pick a different user to bring
						results back into view.
					</div>
				</div>
			)}

			{hasData &&
				!hasNoData &&
				!hasNoFilteredMonthlyResults &&
				(isValidUser ? (
					<ErrorBoundary fallbackMessage="Failed to render this user's timesheet.">
						{selectedEntry ? (
							<TimesheetGrid
								key={selectedUser}
								user={selectedUser}
								days={selectedEntry}
								issueSummaries={issueSummaries}
								onDownloadUser={onDownloadUser}
								absenceDays={getUserAbsenceDayMap(
									monthlyAbsenceDaysByUser,
									userEmails[selectedUser],
								)}
							/>
						) : (
							<TimesheetGrid
								key={selectedUser}
								user={selectedUser}
								days={{}}
								issueSummaries={issueSummaries}
								onDownloadUser={onDownloadUser}
								absenceDays={getUserAbsenceDayMap(
									monthlyAbsenceDaysByUser,
									userEmails[selectedUser],
								)}
							/>
						)}
					</ErrorBoundary>
				) : (
					<>
						<TimesheetStatsCards
							entries={filteredVisibleEntries}
							year={currentYear}
							monthZeroIndexed={currentMonth}
						/>
						{filteredVisibleEntries.length > 1 && (
							<OverviewTable
								entries={filteredVisibleEntries}
								year={currentYear}
								monthZeroIndexed={currentMonth}
								userEmails={userEmails}
								absenceDaysByUser={monthlyAbsenceDaysByUser}
								onUserClick={onUserChange}
							/>
						)}
						{filteredVisibleEntries.map(([user, days]) => (
							<ErrorBoundary
								key={user}
								fallbackMessage={`Failed to render timesheet for ${user}.`}
							>
								<TimesheetGrid
									user={user}
									days={days}
									issueSummaries={issueSummaries}
									onDownloadUser={onDownloadUser}
									absenceDays={getUserAbsenceDayMap(
										monthlyAbsenceDaysByUser,
										userEmails[user],
									)}
								/>
							</ErrorBoundary>
						))}
					</>
				))}
		</>
	);
};
