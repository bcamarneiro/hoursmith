import type React from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConfigStore } from '../../stores/useConfigStore';
import { useDashboardStore } from '../../stores/useDashboardStore';
import { DayCard } from '../components/dashboard/DayCard';
import { FavoritesManager } from '../components/dashboard/FavoritesManager';
import { KeyboardShortcutsHelp } from '../components/dashboard/KeyboardShortcutsHelp';
import { MonthHeatmap } from '../components/dashboard/MonthHeatmap';
import { OfflineIndicator } from '../components/dashboard/OfflineIndicator';
import { SourceStatusBar } from '../components/dashboard/SourceStatusBar';
import { TemplatesManager } from '../components/dashboard/TemplatesManager';
import { WeeklyCloseAssistant } from '../components/dashboard/WeeklyCloseAssistant';
import { WeekNavigator } from '../components/dashboard/WeekNavigator';
import { WeekOverview } from '../components/dashboard/WeekOverview';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { toast } from '../components/ui/Toast';
import { WorklogLoadingStatus } from '../components/ui/WorklogLoadingStatus';
import { useAbsenceDays } from '../hooks/useAbsenceDays';
import { useComplianceReminder } from '../hooks/useComplianceReminder';
import { useCopyPreviousWeek } from '../hooks/useCopyPreviousWeek';
import { useDashboardDataFetcher } from '../hooks/useDashboardDataFetcher';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useMonthHeatmapData } from '../hooks/useMonthHeatmapData';
import { usePageTitle } from '../hooks/usePageTitle';
import { addDaysToIsoDate } from '../utils/date';
import { downloadAsFile } from '../utils/downloadFile';
import { generateWeeklyCsv } from '../utils/weekCsvExport';
import { buildWeeklyCloseAssistantModel } from '../utils/weeklyCloseAssistant';
import { generateWeeklySummary } from '../utils/weekSummary';
import * as styles from './MyWeekPage.module.css';

const GAP_DAYS_SECTION_ID = 'dashboard-gap-days';

export const MyWeekPage: React.FC = () => {
	usePageTitle('My Week');
	useDashboardDataFetcher();

	const jiraHost = useConfigStore((s) => s.config.jiraHost);
	const weekStart = useDashboardStore((s) => s.weekStart);
	const weekEnd = useDashboardStore((s) => s.weekEnd);
	const daySummaries = useDashboardStore((s) => s.daySummaries);
	const isLoadingWorklogs = useDashboardStore((s) => s.isLoadingWorklogs);
	const goToPrevWeek = useDashboardStore((s) => s.goToPrevWeek);
	const goToNextWeek = useDashboardStore((s) => s.goToNextWeek);
	const goToCurrentWeek = useDashboardStore((s) => s.goToCurrentWeek);
	const worklogsError = useDashboardStore((s) => s.worklogsError);
	const weekWorklogs = useDashboardStore((s) => s.weekWorklogs);
	const worklogsLoadingProgress = useDashboardStore(
		(s) => s.worklogsLoadingProgress,
	);

	const [isFavoritesOpen, setIsFavoritesOpen] = useState(false);
	const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);

	const weekdays = daySummaries.filter((d) => !d.isWeekend);
	const { focusedDayIndex, focusedSuggestionIndex, showHelp, setShowHelp } =
		useKeyboardShortcuts(weekdays);
	const { canRemind, reminderEnabled, enableReminder, totalGapHours } =
		useComplianceReminder();
	const { copyPreviousWeek, isLoading: isCopyingPrevWeek } =
		useCopyPreviousWeek();
	const monthHeatmap = useMonthHeatmapData();

	// Fetch absence days for the heatmap month range
	const heatmapMonthStart = `${monthHeatmap.year}-${String(monthHeatmap.month + 1).padStart(2, '0')}-01`;
	const heatmapDaysInMonth = new Date(
		monthHeatmap.year,
		monthHeatmap.month + 1,
		0,
	).getDate();
	const heatmapMonthEnd = addDaysToIsoDate(
		heatmapMonthStart,
		heatmapDaysInMonth - 1,
	);
	const { data: absenceDays, error: absenceError } = useAbsenceDays(
		heatmapMonthStart,
		heatmapMonthEnd,
	);
	const closeAssistantModel = useMemo(
		() =>
			buildWeeklyCloseAssistantModel({
				days: daySummaries,
				weekWorklogs,
				canRemind,
				reminderEnabled,
				totalGapHours,
			}),
		[daySummaries, weekWorklogs, canRemind, reminderEnabled, totalGapHours],
	);

	const handleExportMd = async () => {
		const markdown = generateWeeklySummary(weekStart, weekEnd, weekWorklogs);
		try {
			await navigator.clipboard.writeText(markdown);
			toast.success('Weekly summary copied to clipboard');
		} catch {
			toast.error('Failed to copy to clipboard');
		}
	};

	const handleExportCsv = () => {
		const configSnapshot = useConfigStore.getState().config;
		const csv = generateWeeklyCsv(weekStart, weekEnd, weekWorklogs, {
			provenance: { jiraHost: configSnapshot.jiraHost },
			absenceDays,
			includeAbsenceColumns: configSnapshot.includeAbsenceInCsv,
		});
		const filename = `timesheet-${weekStart}-${weekEnd}.csv`;
		downloadAsFile(csv, filename, 'text/csv;charset=utf-8');
		toast.success('CSV file downloaded');
	};

	const handleCopyPrevWeek = async () => {
		try {
			const copiedCount = await copyPreviousWeek();
			if (copiedCount === 0) {
				toast.error('No worklogs found in the previous week');
				return;
			}
			toast.success(
				`Copied ${copiedCount} suggestion${copiedCount === 1 ? '' : 's'} from the previous week`,
			);
		} catch {
			toast.error('Failed to copy previous week');
		}
	};

	if (!jiraHost) {
		return (
			<div className={styles.container}>
				<section className={styles.emptySetup}>
					<div className={styles.emptySetupText}>
						<h2>Set up Jira before you use Dashboard</h2>
						<p>
							Dashboard works best once Jira is connected and the core checks
							pass. After that, this becomes the fastest place to close the
							week.
						</p>
						<ul className={styles.emptyChecklist}>
							<li>Connect your Jira host, email, and API token</li>
							<li>Run diagnostics to confirm auth, permissions, and CORS</li>
							<li>Come back here to fill gaps, reuse prior work, and export</li>
						</ul>
					</div>
					<div className={styles.emptyActions}>
						<Link to="/settings" className={styles.primaryLink}>
							Start setup
						</Link>
						<Link to="/" className={styles.secondaryLink}>
							Back to Home
						</Link>
					</div>
				</section>
			</div>
		);
	}

	if (worklogsError) {
		return (
			<div className={styles.container}>
				<div className={styles.toolbar}>
					<WeekNavigator
						weekStart={weekStart}
						weekEnd={weekEnd}
						onPrev={goToPrevWeek}
						onNext={goToNextWeek}
						onToday={goToCurrentWeek}
					/>
					<SourceStatusBar />
				</div>
				<div className={styles.error}>
					<h2>Unable to load dashboard</h2>
					<p>{worklogsError}</p>
					<Link to="/settings">Check your settings</Link>
				</div>
			</div>
		);
	}

	const hasGaps = weekdays.some((d) => d.gapSeconds > 0);
	const jumpToGapDays = () => {
		document.getElementById(GAP_DAYS_SECTION_ID)?.scrollIntoView({
			behavior: 'smooth',
			block: 'start',
		});
	};

	return (
		<div className={styles.container}>
			<OfflineIndicator />
			<div className={styles.toolbar}>
				<WeekNavigator
					weekStart={weekStart}
					weekEnd={weekEnd}
					onPrev={goToPrevWeek}
					onNext={goToNextWeek}
					onToday={goToCurrentWeek}
				/>
				<div className={styles.toolbarRight}>
					<Button variant="secondary" onClick={() => setIsFavoritesOpen(true)}>
						Pinned
					</Button>
					<Button variant="secondary" onClick={() => setIsTemplatesOpen(true)}>
						Templates
					</Button>
					<Button
						variant="secondary"
						onClick={handleCopyPrevWeek}
						disabled={isCopyingPrevWeek || daySummaries.length === 0}
					>
						{isCopyingPrevWeek ? 'Copying...' : 'Copy Prev Week'}
					</Button>
					<Button
						variant="secondary"
						onClick={handleExportMd}
						disabled={weekWorklogs.length === 0}
					>
						Export MD
					</Button>
					<Button
						variant="secondary"
						onClick={handleExportCsv}
						disabled={weekWorklogs.length === 0}
					>
						Export CSV
					</Button>
					<button
						type="button"
						className={styles.helpButton}
						onClick={() => setShowHelp(true)}
						aria-label="Open keyboard shortcuts help"
						title="Keyboard shortcuts (?)"
					>
						?
					</button>
					<SourceStatusBar />
				</div>
			</div>

			{absenceError && (
				<output className={styles.absenceBanner} aria-live="polite">
					<strong>Time-off calendar unavailable.</strong> Your absence feed
					couldn't be loaded — compliance targets won't be adjusted for
					vacation/holidays until it's reachable again. Other dashboard data is
					unaffected.
					<span className={styles.absenceBannerDetail}>
						(
						{absenceError instanceof Error
							? absenceError.message
							: 'unknown error'}
						)
					</span>
				</output>
			)}

			{!isLoadingWorklogs && daySummaries.length === 0 && (
				<div className={styles.emptyWeek}>
					<h3>No worklogs found for this week</h3>
					<p>
						Try another week, adjust your filters, or check your Jira settings.
					</p>
				</div>
			)}

			{isLoadingWorklogs && daySummaries.length === 0 && (
				<div className={styles.loading}>
					<WorklogLoadingStatus
						title="Loading your week"
						progress={worklogsLoadingProgress}
					/>
				</div>
			)}

			{daySummaries.length > 0 && (
				<>
					{isLoadingWorklogs && (
						<div className={styles.refetching}>
							<WorklogLoadingStatus
								title="Updating your week"
								progress={worklogsLoadingProgress}
								compact
							/>
						</div>
					)}

					<WeekOverview days={daySummaries} />

					{weekdays.length > 0 && (
						<div id={GAP_DAYS_SECTION_ID} className={styles.daysSection}>
							<h3 className={styles.sectionTitle}>This week</h3>
							{/* All weekdays render in order; complete days collapse in
							    place (DayCard) instead of disappearing, so they stay
							    reviewable and editable. */}
							{weekdays.map((day, i) => (
								<DayCard
									key={day.date}
									day={day}
									isFocused={focusedDayIndex === i}
									focusedSuggestionIndex={
										focusedDayIndex === i ? focusedSuggestionIndex : undefined
									}
								/>
							))}
						</div>
					)}

					<WeeklyCloseAssistant
						model={closeAssistantModel}
						canExport={weekWorklogs.length > 0}
						isCopyingPrevWeek={isCopyingPrevWeek}
						onJumpToGapDays={jumpToGapDays}
						onCopyPrevWeek={handleCopyPrevWeek}
						onCopySummary={handleExportMd}
						onExportCsv={handleExportCsv}
						onEnableReminders={enableReminder}
					/>

					{monthHeatmap.isLoading && monthHeatmap.data.size === 0 && (
						<div className={styles.heatmapLoading}>
							<Spinner size="sm" />
							<span>Loading month overview...</span>
						</div>
					)}
					{monthHeatmap.data.size > 0 && (
						<MonthHeatmap
							monthData={monthHeatmap.data}
							backdatedSeconds={monthHeatmap.backdatedSeconds}
							month={monthHeatmap.month}
							year={monthHeatmap.year}
							absenceDays={absenceDays}
						/>
					)}

					{!hasGaps && (
						<div className={styles.allDone}>
							<div className={styles.allDoneIcon}>&#10003;</div>
							<div className={styles.allDoneTitle}>All caught up!</div>
							<div className={styles.allDoneText}>
								Every weekday this week has 8+ hours logged.
							</div>
						</div>
					)}
				</>
			)}

			<FavoritesManager
				isOpen={isFavoritesOpen}
				onClose={() => setIsFavoritesOpen(false)}
			/>
			<TemplatesManager
				isOpen={isTemplatesOpen}
				onClose={() => setIsTemplatesOpen(false)}
			/>
			<KeyboardShortcutsHelp
				isOpen={showHelp}
				onClose={() => setShowHelp(false)}
			/>
		</div>
	);
};
