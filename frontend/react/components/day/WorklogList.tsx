import type React from 'react';
import type { EnrichedJiraWorklog } from '../../../../types/jira';
import type { GhostEntry } from '../../utils/projectDays';
import { classifyWorklog } from '../../utils/worklogClassifier';
import { GhostWorklogItem } from './GhostWorklogItem';
import { WorklogItem } from './WorklogItem';
import * as styles from './WorklogList.module.css';

type Props = {
	worklogs: EnrichedJiraWorklog[];
	ghosts?: GhostEntry[];
	issueSummaries: Record<string, string>;
	onEdit?: (worklog: EnrichedJiraWorklog) => void;
	onDelete?: (worklog: EnrichedJiraWorklog) => void;
};

export const WorklogList: React.FC<Props> = ({
	worklogs,
	ghosts,
	issueSummaries,
	onEdit,
	onDelete,
}) => {
	const regular: EnrichedJiraWorklog[] = [];
	const backdated: EnrichedJiraWorklog[] = [];

	for (const wl of worklogs) {
		if (wl.classified?.isBackdated ?? classifyWorklog(wl).isBackdated) backdated.push(wl);
		else regular.push(wl);
	}

	return (
		<div className={styles.list}>
			{regular.map((wl) => (
				<WorklogItem
					key={wl.id}
					worklog={wl}
					issueSummaries={issueSummaries}
					onEdit={onEdit}
					onDelete={onDelete}
				/>
			))}

			{backdated.length > 0 && (
				<div className={styles.section}>
					<h3 className={styles.sectionHeader}>
						Backdated submissions ({backdated.length})
					</h3>
					{backdated.map((wl) => (
						<WorklogItem
							key={wl.id}
							worklog={wl}
							issueSummaries={issueSummaries}
							onEdit={onEdit}
							onDelete={onDelete}
						/>
					))}
				</div>
			)}

			{ghosts && ghosts.length > 0 && (
				<div className={styles.section}>
					<h3
						className={styles.sectionHeader}
						title="Reconciled in another month — does not count toward this day"
					>
						Reconciled later ({ghosts.length})
					</h3>
					{ghosts.map((g) => (
						<GhostWorklogItem key={`ghost-${g.worklog.id}`} ghost={g} />
					))}
				</div>
			)}
		</div>
	);
};
