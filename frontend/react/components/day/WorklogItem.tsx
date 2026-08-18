import type React from 'react';
import type { EnrichedJiraWorklog } from '../../../../types/jira';
import { useConfigStore } from '../../../stores/useConfigStore';
import { formatHours } from '../../utils/format';
import { truncate } from '../../utils/text';
import { classifyWorklog } from '../../utils/worklogClassifier';
import * as styles from './WorklogItem.module.css';

type Props = {
	worklog: EnrichedJiraWorklog;
	issueSummaries: Record<string, string>;
	onEdit?: (worklog: EnrichedJiraWorklog) => void;
	onDelete?: (worklog: EnrichedJiraWorklog) => void;
};

export const WorklogItem: React.FC<Props> = ({
	worklog,
	issueSummaries,
	onEdit,
	onDelete,
}) => {
	const jiraDomain = useConfigStore((state) => state.config.jiraHost);
	const keyOrId = worklog.issue?.key ?? worklog.issueId;
	const issueTitle =
		issueSummaries[worklog.issue?.key ?? ''] ||
		issueSummaries[worklog.issue?.id ?? ''] ||
		worklog.issue?.fields.summary ||
		'';
	const comment = typeof worklog.comment === 'string' ? worklog.comment : '';
	const classified = worklog.classified ?? classifyWorklog(worklog);
	const isRetroactive = classified.isBackdated;
	const retroactiveLabel = isRetroactive
		? `Logged ${classified.daysLate}d after the work date (intended ${classified.intendedFor}, logged ${classified.loggedOn})`
		: '';
	const tooltip = [
		issueTitle ? `Issue: ${issueTitle}` : '',
		comment ? `Comment: ${truncate(comment)}` : '',
		isRetroactive ? `⚠️ ${retroactiveLabel}` : '',
	]
		.filter(Boolean)
		.join('\n');
	// Dedup: a single icon conveys both retroactive status and any extra
	// info (issue title / comment). When backdated, use ⚠️ and roll the
	// detail into its tooltip; otherwise show 🛈 only when there is detail.
	const showIcon = isRetroactive || !!issueTitle || !!comment;
	const iconGlyph = isRetroactive ? '⚠️' : '🛈';
	const iconClass = isRetroactive ? styles.retroactiveIcon : styles.tooltipIcon;
	const iconTitle = tooltip || retroactiveLabel;

	return (
		<div className={styles.container}>
			<div className={styles.info}>
				<span className={styles.hours}>
					{formatHours(worklog.timeSpentSeconds ?? 0)}
				</span>
				<a
					href={`https://${jiraDomain}/browse/${keyOrId}?focusedId=${worklog.id}&page=com.atlassian.jira.plugin.system.issuetabpanels%3Aworklog-tabpanel#worklog-${worklog.id}`}
					target="_blank"
					rel="noreferrer"
					className={styles.issueLink}
				>
					{keyOrId}
				</a>
				{showIcon && (
					<span title={iconTitle} className={iconClass}>
						{iconGlyph}
					</span>
				)}
			</div>
			{(onEdit || onDelete) && (
				<div className={styles.actions}>
					{onEdit && (
						<button
							type="button"
							onClick={() => onEdit(worklog)}
							className={styles.actionButton}
							title="Edit worklog"
							aria-label={`Edit worklog for ${keyOrId}`}
						>
							✏️
						</button>
					)}
					{onDelete && (
						<button
							type="button"
							onClick={() => onDelete(worklog)}
							className={styles.actionButton}
							title="Delete worklog"
							aria-label={`Delete worklog for ${keyOrId}`}
						>
							🗑️
						</button>
					)}
				</div>
			)}
		</div>
	);
};
