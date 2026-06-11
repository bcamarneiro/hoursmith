import { memo, useMemo, useState } from 'react';
import type { DaySummary, LoggedWorklog } from '../../../../types/Suggestion';
import { useDashboardStore } from '../../../stores/useDashboardStore';
import { useWorklogOperations } from '../../hooks/useWorklogOperations';
import { getAbsenceKindLabel } from '../../utils/absence';
import {
	formatDateTimeLocalValue,
	parseIsoDateLocal,
	toLocalDateString,
	withLocalOffset,
} from '../../utils/date';
import { formatHours, formatJiraTimeSpent } from '../../utils/format';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import { WorklogForm } from '../worklog/WorklogForm';
import { CloneWorklogPopover } from './CloneWorklogPopover';
import * as styles from './DayCard.module.css';
import { DayNote } from './DayNote';
import { SuggestionCard } from './SuggestionCard';

type Props = {
	day: DaySummary;
	isFocused?: boolean;
	focusedSuggestionIndex?: number;
};

const DAY_NAMES = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
];

function formatDate(dateStr: string): string {
	const d = parseIsoDateLocal(dateStr);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatActivityTime(seconds: number): string {
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return formatHours(seconds);
}

export const DayCard = memo<Props>(function DayCard({
	day,
	isFocused,
	focusedSuggestionIndex,
}) {
	const fillDayGap = useDashboardStore((s) => s.fillDayGap);
	const weekGhosts = useDashboardStore((s) => s.weekGhosts);
	const dayGhosts = useMemo(
		() => weekGhosts.filter((g) => g.date === day.date),
		[weekGhosts, day.date],
	);
	const [ghostsExpanded, setGhostsExpanded] = useState(false);
	const markMultipleSuggestionsLogged = useDashboardStore(
		(s) => s.markMultipleSuggestionsLogged,
	);
	const unmarkMultipleSuggestionsLogged = useDashboardStore(
		(s) => s.unmarkMultipleSuggestionsLogged,
	);
	const {
		createMultipleWorklogs,
		deleteWorklog,
		updateWorklog,
		getWorklog,
		isLoading: isWorklogOpLoading,
	} = useWorklogOperations();
	const [isBatchLogging, setIsBatchLogging] = useState(false);
	const activeSuggestions = day.suggestions.filter((s) => !s.logged);
	const loggableSuggestions = activeSuggestions.filter((s) => !!s.issueKey);
	const loggedSuggestions = day.suggestions.filter((s) => s.logged);
	const isToday = day.date === toLocalDateString(new Date());
	const isTimeOff = !day.isWeekend && day.targetSeconds === 0;
	const absenceLabel = isTimeOff
		? getAbsenceKindLabel(day.absenceKind)
		: undefined;
	const rt = day.rescueTime;
	const showFillButton = day.gapSeconds > 0 && activeSuggestions.length > 0;
	// A weekday with no remaining gap is "closed": keep it visible but collapsed
	// (instead of dropping it from the page) so it stays reviewable/editable.
	// Today stays expanded so it's easy to keep working on.
	const isClosed = !day.isWeekend && day.gapSeconds === 0;
	const [expanded, setExpanded] = useState<boolean>(() => !isClosed || isToday);
	const [cloneSource, setCloneSource] = useState<LoggedWorklog | null>(null);
	const [editingWorklog, setEditingWorklog] = useState<{
		worklog: LoggedWorklog;
		initial: {
			issueKey: string;
			timeSpent: string;
			comment: string;
			started: string;
		};
	} | null>(null);
	const [isEditOpening, setIsEditOpening] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<LoggedWorklog | null>(null);

	// Open the edit form for a logged worklog. We fetch the worklog first so the
	// form prefills the real comment/started — editing only the time then keeps
	// them intact (updateWorklog PUTs all three).
	const handleEditOpen = async (wl: LoggedWorklog) => {
		setIsEditOpening(true);
		try {
			const current = await getWorklog(wl.issueKey, wl.worklogId);
			setEditingWorklog({
				worklog: wl,
				initial: {
					issueKey: wl.issueKey,
					timeSpent:
						current.timeSpent || formatJiraTimeSpent(wl.timeSpentSeconds),
					comment: current.comment,
					started: current.started
						? formatDateTimeLocalValue(new Date(current.started))
						: formatDateTimeLocalValue(new Date(`${day.date}T09:00`)),
				},
			});
		} catch {
			toast.error('Could not load this worklog to edit');
		} finally {
			setIsEditOpening(false);
		}
	};

	const handleEditSubmit = async (data: {
		issueKey: string;
		timeSpent: string;
		comment: string;
		started: string;
	}) => {
		if (!editingWorklog) return;
		try {
			await updateWorklog(
				editingWorklog.worklog.issueKey,
				editingWorklog.worklog.worklogId,
				{
					timeSpent: data.timeSpent,
					comment: data.comment,
					started: data.started,
				},
			);
			setEditingWorklog(null);
			toast.success('Worklog updated');
		} catch {
			toast.error('Failed to update worklog');
		}
	};

	const handleDeleteConfirm = async () => {
		if (!deleteTarget) return;
		try {
			await deleteWorklog(deleteTarget.issueKey, deleteTarget.worklogId);
			setDeleteTarget(null);
			toast.success('Worklog deleted');
		} catch {
			toast.error('Failed to delete worklog');
		}
	};

	const handleClone = async (source: LoggedWorklog, dates: string[]) => {
		if (dates.length === 0) return;
		const timeSpent = formatJiraTimeSpent(source.timeSpentSeconds);
		try {
			const params = dates.map((d) => ({
				issueKey: source.issueKey,
				timeSpent,
				comment: '',
				started: withLocalOffset(`${d}T09:00`),
			}));

			const result = await createMultipleWorklogs(params);
			setCloneSource(null);

			if (result.failed.length === 0) {
				toast.success(
					`Cloned ${source.issueKey} (${timeSpent}) to ${result.success} day${
						result.success === 1 ? '' : 's'
					}`,
					{
						action: {
							label: 'Undo',
							onClick: () => {
								Promise.all(
									result.created.map((w) =>
										deleteWorklog(w.issueKey, w.worklogId),
									),
								);
							},
						},
					},
				);
			} else {
				toast.error(
					`Cloned ${result.success} of ${params.length}: failed ${result.failed.join(', ')}`,
				);
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Clone failed');
		}
	};

	const handleLogAll = async () => {
		setIsBatchLogging(true);
		try {
			const params = loggableSuggestions.map((s) => ({
				issueKey: s.issueKey,
				timeSpent: s.suggestedTimeSpent,
				comment: '',
				started: withLocalOffset(`${s.date}T09:00`),
			}));

			if (params.length === 0) {
				toast.error('No mapped suggestions available to log');
				return;
			}

			const result = await createMultipleWorklogs(params);

			// Mark successful suggestions as logged
			const failedKeys = new Set(result.failed);
			const successIds = loggableSuggestions
				.filter((s) => !failedKeys.has(s.issueKey))
				.map((s) => s.id);

			if (successIds.length > 0) {
				markMultipleSuggestionsLogged(successIds);
			}

			if (result.failed.length === 0) {
				toast.success(
					`Logged all ${result.success} worklogs for ${DAY_NAMES[day.dayOfWeek]}`,
					{
						action: {
							label: 'Undo',
							onClick: () => {
								Promise.all(
									result.created.map((w) =>
										deleteWorklog(w.issueKey, w.worklogId),
									),
								).then(() => {
									unmarkMultipleSuggestionsLogged(successIds);
								});
							},
						},
					},
				);
			} else {
				toast.error(
					`Logged ${result.success} of ${params.length}: failed ${result.failed.join(', ')}`,
				);
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Batch log failed');
		} finally {
			setIsBatchLogging(false);
		}
	};

	return (
		<div
			className={`${styles.card} ${isToday ? styles.today : ''} ${day.isWeekend ? styles.weekend : ''} ${isFocused ? styles.focused : ''} ${isClosed && !expanded ? styles.closed : ''}`}
		>
			<div className={styles.header}>
				<div className={styles.dayInfo}>
					<span className={styles.dayName}>{DAY_NAMES[day.dayOfWeek]}</span>
					<span className={styles.dayDate}>{formatDate(day.date)}</span>
					{isToday && <span className={styles.todayBadge}>Today</span>}
				</div>
				<div className={styles.stats}>
					<span className={styles.logged}>
						{formatHours(day.loggedSeconds)}
					</span>
					{isTimeOff && <span className={styles.timeOff}>{absenceLabel}</span>}
					{day.gapSeconds > 0 && (
						<span className={styles.gap}>-{formatHours(day.gapSeconds)}</span>
					)}
					{rt && (
						<span
							className={styles.rescueTime}
							title="RescueTime productive hours"
						>
							RT: {(rt.productiveSeconds / 3600).toFixed(1)}h
						</span>
					)}
					{showFillButton && (
						<button
							type="button"
							className={styles.fillButton}
							onClick={() => fillDayGap(day.date)}
							aria-label={`Fill remaining gap for ${DAY_NAMES[day.dayOfWeek]}`}
						>
							Fill day
						</button>
					)}
					{activeSuggestions.length > 0 && (
						<button
							type="button"
							className={styles.logAllButton}
							onClick={handleLogAll}
							disabled={isBatchLogging || loggableSuggestions.length === 0}
							aria-label={`Log all mapped suggestions for ${DAY_NAMES[day.dayOfWeek]}`}
							title={
								loggableSuggestions.length === 0
									? 'Map suggestions to Jira issues before logging all'
									: undefined
							}
						>
							{isBatchLogging ? 'Logging...' : 'Log All'}
						</button>
					)}
					{isClosed && !isTimeOff && (
						<span className={styles.closedChip}>✓ Closed</span>
					)}
					{isClosed && (
						<button
							type="button"
							className={styles.collapseToggle}
							onClick={() => setExpanded((v) => !v)}
							aria-expanded={expanded}
							aria-label={`${expanded ? 'Collapse' : 'Expand'} ${DAY_NAMES[day.dayOfWeek]}`}
						>
							{expanded ? '▴' : '▾'}
						</button>
					)}
				</div>
			</div>

			{expanded && (
				<>
					<DayNote date={day.date} />

					{rt && rt.topActivities.length > 0 && (
						<div className={styles.activities}>
							{rt.topActivities.map((a, i) => (
								<span
									key={`${a.name}-${i}`}
									className={styles.activityPill}
									title={`${a.category} — ${formatActivityTime(a.seconds)}`}
								>
									{a.name}{' '}
									<span className={styles.activityTime}>
										{formatActivityTime(a.seconds)}
									</span>
								</span>
							))}
						</div>
					)}

					{activeSuggestions.length > 0 && (
						<div className={styles.suggestions}>
							{activeSuggestions.map((s, i) => (
								<SuggestionCard
									key={s.id}
									suggestion={s}
									isFocused={isFocused && focusedSuggestionIndex === i}
								/>
							))}
						</div>
					)}

					{loggedSuggestions.length > 0 && (
						<div className={styles.suggestions}>
							{loggedSuggestions.map((s) => (
								<SuggestionCard key={s.id} suggestion={s} />
							))}
						</div>
					)}

					{day.loggedWorklogs.length > 0 && (
						<div className={styles.loggedWorklogs}>
							{day.loggedWorklogs.map((wl) => (
								<div key={wl.worklogId} className={styles.loggedWorklog}>
									<span className={styles.loggedWorklogCheck}>&#10003;</span>
									<span className={styles.loggedWorklogKey}>{wl.issueKey}</span>
									<span className={styles.loggedWorklogTime}>
										{formatHours(wl.timeSpentSeconds)}
									</span>
									{wl.issueSummary && (
										<span className={styles.loggedWorklogSummary}>
											{wl.issueSummary}
										</span>
									)}
									<div className={styles.worklogActions}>
										<button
											type="button"
											className={styles.cloneButton}
											onClick={() => handleEditOpen(wl)}
											disabled={isEditOpening}
											aria-label={`Edit the time logged on ${wl.issueKey}`}
										>
											Edit
										</button>
										<button
											type="button"
											className={styles.cloneButton}
											onClick={() => setCloneSource(wl)}
											aria-label={`Clone ${wl.issueKey} to other days`}
										>
											Clone to…
										</button>
										<button
											type="button"
											className={styles.deleteWorklogButton}
											onClick={() => setDeleteTarget(wl)}
											aria-label={`Delete the worklog on ${wl.issueKey}`}
										>
											Delete
										</button>
									</div>
								</div>
							))}
						</div>
					)}

					{!day.isWeekend &&
						!isTimeOff &&
						day.gapSeconds > 0 &&
						activeSuggestions.length === 0 && (
							<div className={styles.noSuggestions}>
								No suggestions available for this day
							</div>
						)}

					{/*
					 * Reconciled later: worklogs whose intendedFor is this day but were
					 * logged in another week. They render here as a courtesy reference and
					 * NEVER count toward day.loggedSeconds or day.gapSeconds — those values
					 * come from useDashboardStore and the dataFetcher excludes ghosts from
					 * the worklog projection that drives gap math.
					 */}
					{dayGhosts.length > 0 && (
						<div className={styles.ghosts}>
							<button
								type="button"
								className={styles.ghostsToggle}
								onClick={() => setGhostsExpanded((v) => !v)}
								aria-expanded={ghostsExpanded}
								aria-controls={`day-ghosts-${day.date}`}
							>
								Reconciled later ({dayGhosts.length})
							</button>
							{ghostsExpanded && (
								<ul
									id={`day-ghosts-${day.date}`}
									className={styles.ghostsList}
									aria-label={`${dayGhosts.length} worklog${
										dayGhosts.length === 1 ? '' : 's'
									} reconciled later for ${day.date}`}
								>
									{dayGhosts.map((g, i) => (
										<li
											key={`${g.intendedFor}-${g.loggedOn}-${g.issueKey ?? 'unknown'}-${i}`}
											className={styles.ghostItem}
											role="note"
											title={`Submitted on ${g.loggedOn} (${g.daysLate}d after this date). Counts toward ${g.loggedOn}, not this day.`}
											aria-label={`Backdated worklog: ${formatHours(g.timeSpentSeconds)}, does not count toward this day, submitted on ${g.loggedOn}`}
										>
											<span className={styles.ghostHours}>
												{formatHours(g.timeSpentSeconds)}
											</span>
											{g.issueKey && (
												<span className={styles.ghostIssue}>{g.issueKey}</span>
											)}
											<span className={styles.ghostArrow} aria-hidden="true">
												→
											</span>
											<span className={styles.ghostLoggedOn}>
												logged {g.loggedOn}
											</span>
										</li>
									))}
								</ul>
							)}
						</div>
					)}
				</>
			)}

			{cloneSource && (
				<Modal
					isOpen
					onClose={() => setCloneSource(null)}
					title="Clone worklog"
				>
					<CloneWorklogPopover
						issueKey={cloneSource.issueKey}
						timeSpent={formatJiraTimeSpent(cloneSource.timeSpentSeconds)}
						sourceDate={day.date}
						onClone={(dates) => handleClone(cloneSource, dates)}
						onCancel={() => setCloneSource(null)}
					/>
				</Modal>
			)}

			{editingWorklog && (
				<Modal
					isOpen
					onClose={() => setEditingWorklog(null)}
					title="Edit worklog"
				>
					<WorklogForm
						initialData={editingWorklog.initial}
						onSubmit={handleEditSubmit}
						onCancel={() => setEditingWorklog(null)}
						isEdit
						isLoading={isWorklogOpLoading}
					/>
				</Modal>
			)}

			{deleteTarget && (
				<ConfirmDialog
					isOpen
					title="Delete worklog"
					message={`Delete the ${formatHours(deleteTarget.timeSpentSeconds)} worklog on ${deleteTarget.issueKey}? This removes it from Jira.`}
					confirmLabel="Delete"
					onConfirm={handleDeleteConfirm}
					onCancel={() => setDeleteTarget(null)}
				/>
			)}
		</div>
	);
});
