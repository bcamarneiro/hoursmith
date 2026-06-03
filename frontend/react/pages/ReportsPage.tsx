import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchMonthWorklogs } from '../../services/monthWorklogService';
import { useConfigStore } from '../../stores/useConfigStore';
import { useTeamStore } from '../../stores/useTeamStore';
import { useTimesheetStore } from '../../stores/useTimesheetStore';
import {
	type ReportPreset,
	useUserDataStore,
} from '../../stores/useUserDataStore';
import { WeekNavigator } from '../components/dashboard/WeekNavigator';
import { MonthNavigator } from '../components/MonthNavigator';
import { ReportsControlPanel } from '../components/reports/ReportsControlPanel';
import { ReportsMonthlyView } from '../components/reports/ReportsMonthlyView';
import { ReportsWeeklyView } from '../components/reports/ReportsWeeklyView';
import { UserSelector } from '../components/UserSelector';
import { toast } from '../components/ui/Toast';
import { useAbsenceDaysByUser } from '../hooks/useAbsenceDays';
import { useDownload } from '../hooks/useDownload';
import { monthWorklogsQueryKey } from '../hooks/useMonthWorklogs';
import { usePageTitle } from '../hooks/usePageTitle';
import { useReportsTrendData } from '../hooks/useReportsTrendData';
import {
	getInitialSelectedUserFromURL,
	useReportsURLState,
} from '../hooks/useReportsURLState';
import { useTeamData } from '../hooks/useTeamData';
import { useTimesheetDataFetcher } from '../hooks/useTimesheetDataFetcher';
import { describeFreshness } from '../utils/dataFreshness';
import { addDaysToIsoDate, monthLabel } from '../utils/date';
import { downloadAsFile } from '../utils/downloadFile';
import { deriveMonthlyReportState } from '../utils/monthlyReport';
import { validateReportsConsistency } from '../utils/reportConsistency';
import {
	buildReportsSnapshotHtml,
	buildReportsSnapshotMarkdown,
} from '../utils/reportSnapshots';
import { buildTeamCsv } from '../utils/teamCsvExport';
import { uid } from '../utils/uid';
import { classifyWorklog } from '../utils/worklogClassifier';
import * as styles from './ReportsPage.module.css';

type SortField = 'name' | 'total' | 'gap';
type SortDirection = 'asc' | 'desc';
type ViewMode = 'monthly' | 'weekly';
type ReportsValidationState = {
	status: 'idle' | 'checking' | 'consistent' | 'inconsistent' | 'error';
	message: string;
	checkedAt: string | null;
	mismatches: Array<{
		displayName: string;
		weeklySeconds: number;
		monthlySeconds: number;
	}>;
};

function slugifyLabel(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function includesSearch(haystack: string, query: string): boolean {
	return haystack.toLowerCase().includes(query);
}

function buildIdleValidationState(
	viewMode: ViewMode,
	weekStart: string,
	weekEnd: string,
): ReportsValidationState {
	return {
		status: 'idle',
		message:
			viewMode === 'weekly'
				? `Ready to validate ${weekStart} to ${weekEnd} against the monthly worklog source.`
				: 'Switch to the Weekly view to validate the current week against monthly totals.',
		checkedAt: null,
		mismatches: [],
	};
}

function sumMonthlyHours(
	entries: ReturnType<typeof deriveMonthlyReportState>['visibleEntries'],
	year: number,
	monthZeroIndexed: number,
): number {
	const monthPrefix = `${year}-${String(monthZeroIndexed + 1).padStart(2, '0')}`;
	let totalSeconds = 0;

	for (const [, days] of entries) {
		for (const [dateKey, worklogs] of Object.entries(days)) {
			if (!dateKey.startsWith(monthPrefix)) continue;
			for (const worklog of worklogs) {
				if (classifyWorklog(worklog).isBackdated) continue;
				totalSeconds += worklog.timeSpentSeconds ?? 0;
			}
		}
	}

	return totalSeconds;
}

// --- Main component ---

export const ReportsPage: React.FC = () => {
	usePageTitle('Reports');
	const queryClient = useQueryClient();
	// Seed selectedUser from ?user= synchronously on first mount so that
	// deep-links like /reports?user=Sarah%20Johnson are reflected in the
	// focus dropdown as soon as the user list lands, without being wiped by
	// the URL-state hook's mount effect running later.
	useState(() => {
		const initial = getInitialSelectedUserFromURL();
		if (initial) {
			useTimesheetStore.getState().setSelectedUser(initial);
		}
		return null;
	});
	const [viewMode, setViewMode] = useState<ViewMode>('weekly');
	const [sortField, setSortField] = useState<SortField>('name');
	const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
	const [searchQuery, setSearchQuery] = useState('');
	const [onlyAttentionNeeded, setOnlyAttentionNeeded] = useState(false);
	const [managerMode, setManagerMode] = useState(false);
	const [trendWeeks, setTrendWeeks] = useState(6);

	// Only fetch data for the active view
	const {
		isLoading,
		isFetching: monthlyFetching,
		dataUpdatedAt: monthlyDataUpdatedAt,
		errorMessage,
		worklogProgress: monthlyWorklogProgress,
	} = useTimesheetDataFetcher({
		enabled: viewMode === 'monthly',
	});

	// Monthly view state
	const currentYear = useTimesheetStore((state) => state.currentYear);
	const currentMonth = useTimesheetStore((state) => state.currentMonth);
	const selectedUser = useTimesheetStore((state) => state.selectedUser);
	const setSelectedUser = useTimesheetStore((state) => state.setSelectedUser);
	const data = useTimesheetStore((state) => state.data);
	const goPrevMonth = useTimesheetStore((state) => state.goPrevMonth);
	const goNextMonth = useTimesheetStore((state) => state.goNextMonth);
	const config = useConfigStore((state) => state.config);
	const jiraDomain = config.jiraHost;
	const allowedUsers = config.allowedUsers;

	// Weekly view state
	const weekStart = useTeamStore((s) => s.weekStart);
	const weekEnd = useTeamStore((s) => s.weekEnd);
	const goToPrevWeek = useTeamStore((s) => s.goToPrevWeek);
	const goToNextWeek = useTeamStore((s) => s.goToNextWeek);
	const goToCurrentWeek = useTeamStore((s) => s.goToCurrentWeek);

	const {
		data: teamMembers,
		isLoading: teamLoading,
		isFetching: teamFetching,
		error: teamError,
		lastUpdatedAt: teamLastUpdatedAt,
		loadingProgress: teamLoadingProgress,
	} = useTeamData(weekStart, weekEnd, { enabled: viewMode === 'weekly' });

	const reportPresets = useUserDataStore((state) => state.reportPresets);
	const saveReportPreset = useUserDataStore((state) => state.saveReportPreset);
	const removeReportPreset = useUserDataStore(
		(state) => state.removeReportPreset,
	);
	const monthStart = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`;
	const monthEnd = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(new Date(currentYear, currentMonth + 1, 0).getDate()).padStart(2, '0')}`;
	const { data: monthlyAbsenceDaysByUser } = useAbsenceDaysByUser(
		monthStart,
		monthEnd,
		{ enabled: viewMode === 'monthly' },
	);
	const { issueSummaries, users, userEmails, grouped, visibleEntries } =
		useMemo(
			() => deriveMonthlyReportState(data, selectedUser, allowedUsers),
			[data, selectedUser, allowedUsers],
		);
	const { downloadUser, downloadAll } = useDownload({
		absenceDaysByUser: monthlyAbsenceDaysByUser,
		userEmails,
	});
	const [validationState, setValidationState] =
		useState<ReportsValidationState>(() =>
			buildIdleValidationState(viewMode, weekStart, weekEnd),
		);

	useReportsURLState({
		viewMode,
		setViewMode,
		searchQuery,
		setSearchQuery,
		onlyAttentionNeeded,
		setOnlyAttentionNeeded,
		managerMode,
		setManagerMode,
		trendWeeks,
		setTrendWeeks,
		sortField,
		setSortField,
		sortDirection,
		setSortDirection,
	});
	const {
		data: trendModel,
		isLoading: trendsLoading,
		error: trendsError,
	} = useReportsTrendData(weekStart, trendWeeks, {
		enabled: viewMode === 'weekly' && managerMode,
	});

	const normalizedSearchQuery = searchQuery.trim().toLowerCase();
	const allMonthlyEntries = useMemo(() => Object.entries(grouped), [grouped]);
	const normalizedSelectedUser = selectedUser.trim().toLowerCase();
	const filteredTeamMembers = useMemo(
		() =>
			teamMembers.filter((member) => {
				const matchesQuery =
					normalizedSearchQuery.length === 0 ||
					includesSearch(member.displayName, normalizedSearchQuery) ||
					includesSearch(member.email, normalizedSearchQuery);
				if (!matchesQuery) return false;
				if (onlyAttentionNeeded && member.gapSeconds === 0) return false;
				if (
					normalizedSelectedUser.length > 0 &&
					member.displayName.trim().toLowerCase() !== normalizedSelectedUser
				) {
					return false;
				}
				return true;
			}),
		[
			teamMembers,
			normalizedSearchQuery,
			onlyAttentionNeeded,
			normalizedSelectedUser,
		],
	);
	const weeklyUsers = useMemo(
		() => teamMembers.map((member) => member.displayName),
		[teamMembers],
	);
	const focusUserList = viewMode === 'weekly' ? weeklyUsers : users;
	const isValidUser =
		selectedUser !== '' && focusUserList.includes(selectedUser);
	const filteredUsers = useMemo(() => {
		if (normalizedSearchQuery.length === 0) return focusUserList;
		return focusUserList.filter((user) =>
			includesSearch(user, normalizedSearchQuery),
		);
	}, [focusUserList, normalizedSearchQuery]);
	const selectableUsers = useMemo(() => {
		if (isValidUser && !filteredUsers.includes(selectedUser)) {
			return [selectedUser, ...filteredUsers];
		}
		return filteredUsers;
	}, [filteredUsers, isValidUser, selectedUser]);
	const filteredVisibleEntries = useMemo(() => {
		if (isValidUser) {
			return visibleEntries;
		}

		if (normalizedSearchQuery.length === 0) {
			return allMonthlyEntries;
		}

		return allMonthlyEntries.filter(([user]) =>
			includesSearch(user, normalizedSearchQuery),
		);
	}, [allMonthlyEntries, isValidUser, normalizedSearchQuery, visibleEntries]);
	const selectedEntry = isValidUser ? grouped[selectedUser] : undefined;

	const sortedMembers = useMemo(() => {
		const sorted = [...filteredTeamMembers];
		sorted.sort((a, b) => {
			let cmp: number;
			switch (sortField) {
				case 'total':
					cmp = a.totalSeconds - b.totalSeconds;
					break;
				case 'gap':
					cmp = a.gapSeconds - b.gapSeconds;
					break;
				default:
					cmp = a.displayName.localeCompare(b.displayName);
			}
			return sortDirection === 'desc' ? -cmp : cmp;
		});
		return sorted;
	}, [filteredTeamMembers, sortField, sortDirection]);

	const handleSort = (field: SortField) => {
		if (sortField === field) {
			setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		} else {
			setSortField(field);
			setSortDirection('asc');
		}
	};

	const handleUserChange = (value: string) => {
		setSelectedUser(value);
	};

	const handleMemberClick = (name: string) => {
		setSelectedUser(name);
		setViewMode('monthly');
	};

	const handleDownloadUser = (user: string) => {
		downloadUser(user, grouped, issueSummaries, currentYear, currentMonth);
	};

	const handleDownloadAll = () => {
		downloadAll(
			filteredVisibleEntries.map(([user]) => user),
			grouped,
			issueSummaries,
			currentYear,
			currentMonth,
		);
	};

	const weekdays = useMemo(
		() =>
			Array.from({ length: 5 }, (_, index) =>
				addDaysToIsoDate(weekStart, index),
			),
		[weekStart],
	);

	const handleExportTeamCsv = () => {
		const csv = buildTeamCsv(sortedMembers, weekdays, {
			provenance: { jiraHost: config.jiraHost },
			includeProvenance: config.includeCsvProvenance,
			includeAbsenceColumns: config.includeAbsenceInCsv,
		});
		const filename = `team-report-${weekStart}.csv`;
		downloadAsFile(csv, filename, 'text/csv;charset=utf-8');
		toast.success('Weekly report exported');
	};

	// Keyboard shortcuts for month/week navigation
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

			if (viewMode === 'monthly') {
				if (e.key === 'ArrowLeft') {
					e.preventDefault();
					goPrevMonth();
				} else if (e.key === 'ArrowRight') {
					e.preventDefault();
					goNextMonth();
				}
			} else {
				if (e.key === 'ArrowLeft') {
					e.preventDefault();
					goToPrevWeek();
				} else if (e.key === 'ArrowRight') {
					e.preventDefault();
					goToNextWeek();
				}
			}
		},
		[viewMode, goPrevMonth, goNextMonth, goToPrevWeek, goToNextWeek],
	);

	useEffect(() => {
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [handleKeyDown]);

	useEffect(() => {
		setValidationState(buildIdleValidationState(viewMode, weekStart, weekEnd));
	}, [viewMode, weekStart, weekEnd]);

	const handleClearFilters = () => {
		setSearchQuery('');
		setOnlyAttentionNeeded(false);
		setManagerMode(false);
		setTrendWeeks(6);
		setSortField('name');
		setSortDirection('asc');
		setSelectedUser('');
		toast.info('Reports filters cleared');
	};

	const handleSavePreset = (label: string) => {
		const trimmedLabel = label.trim();
		if (!trimmedLabel) return;

		saveReportPreset({
			// UUID-based suffix avoids same-millisecond collisions when a user
			// pastes a preset name and saves twice quickly.
			id: `${slugifyLabel(trimmedLabel) || 'preset'}-${uid()}`,
			label: trimmedLabel,
			viewMode,
			searchQuery,
			onlyAttentionNeeded,
			managerMode,
			trendWeeks,
			sortField,
			sortDirection,
			selectedUser,
		});
		toast.success(`Saved preset "${trimmedLabel}"`);
	};

	const handleApplyPreset = (preset: ReportPreset) => {
		setViewMode(preset.viewMode);
		setSearchQuery(preset.searchQuery);
		setOnlyAttentionNeeded(preset.onlyAttentionNeeded);
		setManagerMode(preset.managerMode);
		setTrendWeeks(preset.trendWeeks);
		setSortField(preset.sortField);
		setSortDirection(preset.sortDirection);
		setSelectedUser(preset.selectedUser);
		toast.success(`Applied preset "${preset.label}"`);
	};

	const handleRemovePreset = (id: string) => {
		const preset = reportPresets.find((item) => item.id === id);
		removeReportPreset(id);
		toast.success(
			preset ? `Removed preset "${preset.label}"` : 'Removed report preset',
		);
	};

	const handleCopyShareLink = async () => {
		try {
			await navigator.clipboard.writeText(window.location.href);
			toast.success('Share link copied to clipboard');
		} catch {
			toast.error('Failed to copy share link');
		}
	};

	const buildSnapshotInput = () =>
		viewMode === 'weekly'
			? {
					viewMode: 'weekly' as const,
					jiraHost: jiraDomain,
					weekStart,
					weekEnd,
					searchQuery,
					onlyAttentionNeeded,
					managerMode,
					trendWeeks,
					sortField,
					sortDirection,
					members: sortedMembers,
					validationState,
					trendModel,
				}
			: {
					viewMode: 'monthly' as const,
					jiraHost: jiraDomain,
					monthLabel: monthLabel(currentYear, currentMonth),
					year: currentYear,
					monthZeroIndexed: currentMonth,
					searchQuery,
					selectedUser,
					entries: filteredVisibleEntries,
				};

	const handleExportSnapshotHtml = () => {
		const html = buildReportsSnapshotHtml(buildSnapshotInput());
		const filename =
			viewMode === 'weekly'
				? `reports-snapshot-week-${weekStart}.html`
				: `reports-snapshot-month-${currentYear}-${String(currentMonth + 1).padStart(2, '0')}.html`;
		downloadAsFile(html, filename, 'text/html;charset=utf-8');
		toast.success('Read-only HTML snapshot exported');
	};

	const handleExportSnapshotMarkdown = () => {
		const markdown = buildReportsSnapshotMarkdown(buildSnapshotInput());
		const filename =
			viewMode === 'weekly'
				? `reports-snapshot-week-${weekStart}.md`
				: `reports-snapshot-month-${currentYear}-${String(currentMonth + 1).padStart(2, '0')}.md`;
		downloadAsFile(markdown, filename, 'text/markdown;charset=utf-8');
		toast.success('Read-only Markdown snapshot exported');
	};

	const handleValidateConsistency = async () => {
		if (viewMode !== 'weekly') {
			toast.info('Switch to Weekly to validate weekly and monthly totals');
			return;
		}

		setValidationState({
			status: 'checking',
			message: `Validating ${weekStart} to ${weekEnd} against monthly worklogs...`,
			checkedAt: null,
			mismatches: [],
		});

		try {
			const [startYear, startMonthStr] = weekStart.split('-').map(Number);
			const [endYear, endMonthStr] = weekEnd.split('-').map(Number);
			const monthPairs = new Map<string, { year: number; month: number }>();

			for (const [year, month] of [
				[startYear, startMonthStr - 1],
				[endYear, endMonthStr - 1],
			]) {
				monthPairs.set(`${year}-${month}`, { year, month });
			}

			const results = await Promise.all(
				[...monthPairs.values()].map(({ year, month }) =>
					queryClient.fetchQuery({
						queryKey: monthWorklogsQueryKey(
							year,
							month,
							config.jiraHost,
							config.corsProxy,
							false,
							'',
						),
						queryFn: ({ signal }) =>
							fetchMonthWorklogs(config, year, month, {}, signal),
						staleTime: 15 * 60 * 1000,
					}),
				),
			);
			const result = validateReportsConsistency(
				teamMembers,
				results.flat(),
				weekStart,
				weekEnd,
				allowedUsers,
			);
			const checkedAt = new Date().toLocaleString();

			if (result.matches) {
				setValidationState({
					status: 'consistent',
					message: `Weekly and monthly totals matched for ${result.checkedUsers} user${result.checkedUsers === 1 ? '' : 's'}.`,
					checkedAt,
					mismatches: [],
				});
				toast.success('Weekly and monthly totals are consistent');
				return;
			}

			setValidationState({
				status: 'inconsistent',
				message: `Found ${result.mismatches.length} mismatch${result.mismatches.length === 1 ? '' : 'es'} between weekly and monthly totals.`,
				checkedAt,
				mismatches: result.mismatches,
			});
			toast.error('Reports validation found mismatched totals');
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Validation failed';
			setValidationState({
				status: 'error',
				message,
				checkedAt: new Date().toLocaleString(),
				mismatches: [],
			});
			toast.error(message);
		}
	};

	const hasNoData = !isLoading && !!data && allMonthlyEntries.length === 0;
	const hasNoFilteredMonthlyResults =
		!isLoading &&
		!!data &&
		allMonthlyEntries.length > 0 &&
		filteredVisibleEntries.length === 0;
	const hasNoFilteredWeeklyResults =
		!teamLoading &&
		!teamError &&
		teamMembers.length > 0 &&
		sortedMembers.length === 0;
	const monthlySummary = useMemo(() => {
		if (!data || viewMode !== 'monthly') return null;
		return {
			userCount: filteredVisibleEntries.length,
			totalSeconds: sumMonthlyHours(
				filteredVisibleEntries,
				currentYear,
				currentMonth,
			),
		};
	}, [data, viewMode, filteredVisibleEntries, currentYear, currentMonth]);
	const weeklySummary = useMemo(() => {
		if (viewMode !== 'weekly' || sortedMembers.length === 0) return null;
		return {
			totalSeconds: sortedMembers.reduce(
				(sum, member) => sum + member.totalSeconds,
				0,
			),
			totalGapSeconds: sortedMembers.reduce(
				(sum, member) => sum + member.gapSeconds,
				0,
			),
		};
	}, [viewMode, sortedMembers]);
	const reportsFreshness = useMemo(() => {
		const timestamp =
			viewMode === 'weekly' ? teamLastUpdatedAt : monthlyDataUpdatedAt || null;
		const isRefreshing = viewMode === 'weekly' ? teamFetching : monthlyFetching;
		const baseState = describeFreshness(timestamp);

		if (!isRefreshing) return baseState;

		return {
			label: 'Syncing current view…',
			detail:
				baseState.tone === 'idle'
					? 'Fetching data for this reports view now.'
					: `${baseState.detail} A refresh is in progress.`,
			tone: 'warning' as const,
		};
	}, [
		viewMode,
		teamLastUpdatedAt,
		monthlyDataUpdatedAt,
		teamFetching,
		monthlyFetching,
	]);

	if (errorMessage && viewMode === 'monthly') {
		return (
			<div className={styles.container}>
				<ReportsMonthlyView
					filteredVisibleEntries={filteredVisibleEntries}
					selectedUser={selectedUser}
					isValidUser={isValidUser}
					selectedEntry={selectedEntry}
					userEmails={userEmails}
					issueSummaries={issueSummaries}
					monthlyAbsenceDaysByUser={monthlyAbsenceDaysByUser}
					currentYear={currentYear}
					currentMonth={currentMonth}
					isLoading={isLoading}
					hasData={!!data}
					hasNoData={hasNoData}
					hasNoFilteredMonthlyResults={hasNoFilteredMonthlyResults}
					monthlyWorklogProgress={monthlyWorklogProgress}
					monthlySummary={monthlySummary}
					errorMessage={errorMessage}
					onUserChange={handleUserChange}
					onDownloadUser={handleDownloadUser}
				/>
			</div>
		);
	}

	return (
		<div className={styles.container}>
			<div className={styles.toolbar}>
				{/* View toggle */}
				<div className={styles.viewToggle}>
					<button
						type="button"
						aria-pressed={viewMode === 'weekly'}
						className={
							viewMode === 'weekly'
								? styles.viewToggleButtonActive
								: styles.viewToggleButton
						}
						onClick={() => setViewMode('weekly')}
					>
						Weekly
					</button>
					<button
						type="button"
						aria-pressed={viewMode === 'monthly'}
						className={
							viewMode === 'monthly'
								? styles.viewToggleButtonActive
								: styles.viewToggleButton
						}
						onClick={() => setViewMode('monthly')}
					>
						Monthly
					</button>
				</div>

				{/* Navigation */}
				{viewMode === 'monthly' ? (
					<>
						<UserSelector
							users={selectableUsers}
							value={isValidUser ? selectedUser : ''}
							onChange={handleUserChange}
							label="Monthly focus"
						/>
						<MonthNavigator
							label={monthLabel(currentYear, currentMonth)}
							onPrev={goPrevMonth}
							onNext={goNextMonth}
						/>
					</>
				) : (
					<>
						<UserSelector
							users={selectableUsers}
							value={isValidUser ? selectedUser : ''}
							onChange={handleUserChange}
						/>
						<WeekNavigator
							weekStart={weekStart}
							weekEnd={weekEnd}
							onPrev={goToPrevWeek}
							onNext={goToNextWeek}
							onToday={goToCurrentWeek}
						/>
					</>
				)}

				<div className={styles.toolbarRight}>
					{jiraDomain && <span className={styles.context}>{jiraDomain}</span>}
				</div>
			</div>

			<ReportsControlPanel
				viewMode={viewMode}
				selectedUserLabel={isValidUser ? selectedUser : null}
				monthlyUserCount={users.length}
				searchQuery={searchQuery}
				onlyAttentionNeeded={onlyAttentionNeeded}
				managerMode={managerMode}
				trendWeeks={trendWeeks}
				sortField={sortField}
				sortDirection={sortDirection}
				presets={reportPresets}
				onSearchChange={setSearchQuery}
				onOnlyAttentionNeededChange={setOnlyAttentionNeeded}
				onManagerModeChange={setManagerMode}
				onTrendWeeksChange={setTrendWeeks}
				onClearFilters={handleClearFilters}
				onSavePreset={handleSavePreset}
				onApplyPreset={handleApplyPreset}
				onRemovePreset={handleRemovePreset}
				onCopyShareLink={handleCopyShareLink}
				onExportSnapshotHtml={handleExportSnapshotHtml}
				onExportSnapshotMarkdown={handleExportSnapshotMarkdown}
				onExportPrimary={
					viewMode === 'weekly' ? handleExportTeamCsv : handleDownloadAll
				}
				onValidateConsistency={handleValidateConsistency}
				validationState={validationState}
				primaryExportLabel={
					viewMode === 'weekly'
						? 'Export CSV'
						: filteredVisibleEntries.length > 0
							? 'Export monthly CSVs'
							: null
				}
				canExportPrimary={
					viewMode === 'weekly'
						? sortedMembers.length > 0
						: filteredVisibleEntries.length > 0
				}
				canValidate={
					viewMode === 'weekly' &&
					!!config.jiraHost &&
					!!config.apiToken &&
					!teamLoading &&
					!teamError
				}
				canExportSnapshot={
					viewMode === 'weekly'
						? sortedMembers.length > 0
						: filteredVisibleEntries.length > 0
				}
				dataFreshnessLabel={reportsFreshness.label}
				dataFreshnessDetail={reportsFreshness.detail}
				dataFreshnessTone={reportsFreshness.tone}
			/>

			{viewMode === 'weekly' ? (
				<ReportsWeeklyView
					teamMembers={teamMembers}
					sortedMembers={sortedMembers}
					weekStart={weekStart}
					weekLoading={teamLoading}
					weekFetching={teamFetching}
					teamError={teamError}
					teamLoadingProgress={teamLoadingProgress}
					sortField={sortField}
					sortDirection={sortDirection}
					onSort={handleSort}
					managerMode={managerMode}
					trendWeeks={trendWeeks}
					setTrendWeeks={setTrendWeeks}
					trendModel={trendModel}
					trendsLoading={trendsLoading}
					trendsError={trendsError}
					hasNoFilteredWeeklyResults={hasNoFilteredWeeklyResults}
					weeklySummary={weeklySummary}
					onMemberClick={handleMemberClick}
				/>
			) : (
				<ReportsMonthlyView
					filteredVisibleEntries={filteredVisibleEntries}
					selectedUser={selectedUser}
					isValidUser={isValidUser}
					selectedEntry={selectedEntry}
					userEmails={userEmails}
					issueSummaries={issueSummaries}
					monthlyAbsenceDaysByUser={monthlyAbsenceDaysByUser}
					currentYear={currentYear}
					currentMonth={currentMonth}
					isLoading={isLoading}
					hasData={!!data}
					hasNoData={hasNoData}
					hasNoFilteredMonthlyResults={hasNoFilteredMonthlyResults}
					monthlyWorklogProgress={monthlyWorklogProgress}
					monthlySummary={monthlySummary}
					errorMessage={errorMessage}
					onUserChange={handleUserChange}
					onDownloadUser={handleDownloadUser}
				/>
			)}
		</div>
	);
};
