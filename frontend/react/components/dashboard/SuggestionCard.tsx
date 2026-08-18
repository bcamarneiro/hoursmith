import { memo, useState } from 'react';
import type { WorklogSuggestion } from '../../../../types/Suggestion';
import { reportError } from '../../../services/errorInterceptor';
import { useConfigStore } from '../../../stores/useConfigStore';
import { useDashboardStore } from '../../../stores/useDashboardStore';
import { useUserDataStore } from '../../../stores/useUserDataStore';
import { useWorklogOperations } from '../../hooks/useWorklogOperations';
import { withLocalOffset } from '../../utils/date';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import { WorklogForm } from '../worklog/WorklogForm';
import * as styles from './SuggestionCard.module.css';

type Props = {
	suggestion: WorklogSuggestion;
	isFocused?: boolean;
};

const SOURCE_LABELS: Record<string, string> = {
	'jira-activity': 'Jira',
	gitlab: 'GitLab',
	calendar: 'Calendar',
	rescuetime: 'RescueTime',
	favorite: 'Pinned',
	template: 'Template',
	'previous-week': 'Prev Week',
};

const SOURCE_STYLES: Record<string, string> = {
	'jira-activity': styles.jiraActivity,
	gitlab: styles.gitlab,
	calendar: styles.calendar,
	rescuetime: styles.rescuetime,
	favorite: styles.favorite,
	template: styles.template,
	'previous-week': styles.previousWeek,
};

const CONFIDENCE_STYLES: Record<string, string> = {
	high: styles.high,
	medium: styles.medium,
	low: styles.low,
};

export const SuggestionCard = memo<Props>(function SuggestionCard({
	suggestion,
	isFocused,
}) {
	const jiraDomain = useConfigStore((s) => s.config.jiraHost);
	const timeRounding = useConfigStore((s) => s.config.timeRounding);
	const stepSeconds = timeRounding === '30m' ? 1800 : 900;
	const markLogged = useDashboardStore((s) => s.markSuggestionLogged);
	const unmarkLogged = useDashboardStore((s) => s.unmarkSuggestionLogged);
	const dismiss = useDashboardStore((s) => s.dismissSuggestion);
	const adjustTime = useDashboardStore((s) => s.adjustSuggestionTime);
	const addPatternToMapping = useUserDataStore((s) => s.addPatternToMapping);
	const { createWorklog, deleteWorklog, isLoading } = useWorklogOperations();
	const [isEditOpen, setIsEditOpen] = useState(false);
	const [isMappingOpen, setIsMappingOpen] = useState(false);
	const [mappingIssueKey, setMappingIssueKey] = useState('');
	const [isReasonCollapsed, setIsReasonCollapsed] = useState(false);
	const isLongReason = suggestion.reason.length > 80;
	const canOpenIssue = !!jiraDomain && !!suggestion.issueKey;

	const isUnmapped =
		suggestion.source === 'calendar' &&
		!suggestion.issueKey &&
		!!suggestion.calendarEventTitle;

	const handleMapToIssue = () => {
		const key = mappingIssueKey.trim().toUpperCase();
		if (!key) return;

		addPatternToMapping(key, suggestion.calendarEventTitle || '');
		setIsMappingOpen(false);
		setMappingIssueKey('');
		toast.success(`Mapped "${suggestion.calendarEventTitle}" to ${key}`);
	};

	const handleLogIt = async () => {
		if (!suggestion.issueKey) {
			toast.error(
				'This suggestion needs a Jira issue key before it can be logged',
			);
			return;
		}
		try {
			const worklog = await createWorklog({
				issueKey: suggestion.issueKey,
				timeSpent: suggestion.suggestedTimeSpent,
				comment: '',
				started: withLocalOffset(`${suggestion.date}T09:00`),
			});
			markLogged(suggestion.id);
			const worklogId = worklog.id;
			const undoAction = worklogId
				? {
						action: {
							label: 'Undo',
							onClick: () => {
								deleteWorklog(suggestion.issueKey, worklogId).then(() => {
									unmarkLogged(suggestion.id);
								});
							},
						},
					}
				: undefined;
			toast.success(
				`Logged ${suggestion.suggestedTimeSpent} to ${suggestion.issueKey}`,
				undoAction,
			);
		} catch (e) {
			reportError(e, {
				source: 'Jira worklog',
				fallbackMessage: 'Failed to log',
			});
		}
	};

	const handleEditSubmit = async (data: {
		issueKey: string;
		timeSpent: string;
		comment: string;
		started: string;
	}) => {
		await createWorklog(data);
		markLogged(suggestion.id);
		setIsEditOpen(false);
		toast.success(`Logged to ${data.issueKey}`);
	};

	if (suggestion.logged) {
		return (
			<div className={`${styles.card} ${styles.logged}`}>
				<span className={styles.checkmark}>&#10003;</span>
				<span className={styles.loggedText}>
					{suggestion.suggestedTimeSpent} logged to {suggestion.issueKey}
				</span>
			</div>
		);
	}

	// Unmapped calendar event card
	if (isUnmapped) {
		return (
			<div
				className={`${styles.card} ${styles.unmapped} ${isFocused ? styles.focused : ''}`}
			>
				<div className={styles.header}>
					<div className={styles.issueInfo}>
						<span className={styles.unmappedTitle}>
							{suggestion.calendarEventTitle}
						</span>
					</div>
					<div className={styles.meta}>
						<span className={`${styles.badge} ${styles.calendar}`}>
							Calendar
						</span>
						<span className={styles.unmappedLabel}>Unmapped</span>
					</div>
				</div>
				{isLongReason ? (
					<button
						type="button"
						className={`${styles.reason} ${styles.reasonButton} ${isReasonCollapsed ? styles.reasonTruncated : ''}`}
						onClick={() => setIsReasonCollapsed(!isReasonCollapsed)}
						aria-expanded={!isReasonCollapsed}
					>
						{suggestion.reason}
					</button>
				) : (
					<div className={styles.reason}>{suggestion.reason}</div>
				)}
				{isMappingOpen ? (
					<div className={styles.mappingRow}>
						<input
							type="text"
							className={styles.mappingInput}
							value={mappingIssueKey}
							onChange={(e) => setMappingIssueKey(e.target.value)}
							placeholder="PROJ-123"
							autoCapitalize="characters"
							autoCorrect="off"
							spellCheck={false}
							onKeyDown={(e) => {
								if (e.key === 'Enter') handleMapToIssue();
								if (e.key === 'Escape') setIsMappingOpen(false);
							}}
						/>
						<button
							type="button"
							className={styles.logButton}
							onClick={handleMapToIssue}
							disabled={!mappingIssueKey.trim()}
						>
							Save
						</button>
						<button
							type="button"
							className={styles.dismissButton}
							onClick={() => setIsMappingOpen(false)}
						>
							Cancel
						</button>
					</div>
				) : (
					<div className={styles.actions}>
						<span className={styles.time}>{suggestion.suggestedTimeSpent}</span>
						<button
							type="button"
							className={styles.mapButton}
							onClick={() => setIsMappingOpen(true)}
							aria-label={`Map ${suggestion.calendarEventTitle} to a Jira issue`}
						>
							Map to Issue
						</button>
						<button
							type="button"
							className={styles.dismissButton}
							onClick={() => dismiss(suggestion.id)}
							aria-label={`Dismiss suggestion for ${suggestion.calendarEventTitle}`}
						>
							Dismiss
						</button>
					</div>
				)}
			</div>
		);
	}

	return (
		<>
			<div className={`${styles.card} ${isFocused ? styles.focused : ''}`}>
				<div className={styles.header}>
					<div className={styles.issueInfo}>
						{canOpenIssue ? (
							<a
								href={`https://${jiraDomain}/browse/${suggestion.issueKey}`}
								target="_blank"
								rel="noreferrer"
								className={styles.issueKey}
							>
								{suggestion.issueKey}
							</a>
						) : (
							<span className={styles.issueKey}>{suggestion.issueKey}</span>
						)}
						{suggestion.issueSummary && (
							<span className={styles.issueSummary}>
								{suggestion.issueSummary}
							</span>
						)}
					</div>
					<div className={styles.meta}>
						<span
							className={`${styles.badge} ${SOURCE_STYLES[suggestion.source] ?? ''}`}
							title={`Source: ${SOURCE_LABELS[suggestion.source]}`}
						>
							{SOURCE_LABELS[suggestion.source]}
						</span>
						<span
							className={`${styles.confidence} ${CONFIDENCE_STYLES[suggestion.confidence] ?? ''}`}
							title={`Confidence: ${suggestion.confidence}`}
						>
							{suggestion.confidence}
						</span>
					</div>
				</div>
				{isLongReason ? (
					<button
						type="button"
						className={`${styles.reason} ${styles.reasonButton} ${isReasonCollapsed ? styles.reasonTruncated : ''}`}
						onClick={() => setIsReasonCollapsed(!isReasonCollapsed)}
						aria-expanded={!isReasonCollapsed}
					>
						{suggestion.reason}
					</button>
				) : (
					<div className={styles.reason}>{suggestion.reason}</div>
				)}
				<div className={styles.actions}>
					<div className={styles.timeAdjust}>
						<button
							type="button"
							className={styles.adjustButton}
							onClick={() => adjustTime(suggestion.id, -stepSeconds)}
							disabled={suggestion.suggestedSeconds <= stepSeconds}
							aria-label={`Decrease time by ${stepSeconds / 60} minutes`}
						>
							&minus;
						</button>
						<span className={styles.time}>{suggestion.suggestedTimeSpent}</span>
						<button
							type="button"
							className={styles.adjustButton}
							onClick={() => adjustTime(suggestion.id, stepSeconds)}
							aria-label={`Increase time by ${stepSeconds / 60} minutes`}
						>
							+
						</button>
					</div>
					<button
						type="button"
						className={styles.logButton}
						onClick={handleLogIt}
						disabled={isLoading}
						aria-label={`Log ${suggestion.suggestedTimeSpent} to ${suggestion.issueKey}`}
					>
						Log it
					</button>
					<button
						type="button"
						className={styles.editButton}
						onClick={() => setIsEditOpen(true)}
						aria-label={`Edit and log suggestion for ${suggestion.issueKey}`}
					>
						Edit & Log
					</button>
					<button
						type="button"
						className={styles.dismissButton}
						onClick={() => dismiss(suggestion.id)}
						aria-label={`Dismiss suggestion for ${suggestion.issueKey}`}
					>
						Dismiss
					</button>
				</div>
			</div>

			<Modal
				isOpen={isEditOpen}
				onClose={() => setIsEditOpen(false)}
				title="Log Worklog"
			>
				<WorklogForm
					initialData={{
						issueKey: suggestion.issueKey,
						timeSpent: suggestion.suggestedTimeSpent,
						comment: '',
						started: `${suggestion.date}T09:00`,
					}}
					onSubmit={handleEditSubmit}
					onCancel={() => setIsEditOpen(false)}
					isLoading={isLoading}
				/>
			</Modal>
		</>
	);
});
