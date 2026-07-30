import type React from 'react';
import { useMemo } from 'react';
import { useDashboardStore } from '../../../stores/useDashboardStore';
import { Modal } from '../ui/Modal';
import * as styles from './RecentActivity.module.css';

type Props = {
	isOpen: boolean;
	onClose: () => void;
};

interface IssueActivity {
	issueKey: string;
	issueSummary?: string;
	totalSeconds: number;
	/** Sorted asc by date; one suggestion per day */
	entries: Array<{
		date: string;
		reason: string;
		suggestedTimeSpent: string;
	}>;
}

function formatDayLabel(isoDate: string): string {
	// Parse UTC to avoid timezone shifts when constructing from yyyy-mm-dd
	const [y, m, d] = isoDate.split('-').map(Number);
	const dt = new Date(y, m - 1, d);
	return dt.toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
}

function formatTotalDuration(totalSeconds: number): string {
	const hours = totalSeconds / 3600;
	return hours >= 1
		? `${Math.floor(hours)}h${totalSeconds % 3600 > 0 ? ` ${Math.round((totalSeconds % 3600) / 60)}m` : ''}`
		: `${Math.round(totalSeconds / 60)}m`;
}

export const RecentActivity: React.FC<Props> = ({ isOpen, onClose }) => {
	const daySummaries = useDashboardStore((s) => s.daySummaries);

	const issueActivities = useMemo(() => {
		const allSuggestions = daySummaries.flatMap((day) => day.suggestions);
		const jiraSuggestions = allSuggestions.filter(
			(s) => s.source === 'jira-activity',
		);

		// Group by issueKey and deduplicate by date (keep last entry per date)
		const grouped = new Map<
			string,
			Map<string, { reason: string; suggestedTimeSpent: string }>
		>();
		let grandTotal = 0;

		for (const s of jiraSuggestions) {
			let issueMap = grouped.get(s.issueKey);
			if (!issueMap) {
				issueMap = new Map();
				grouped.set(s.issueKey, issueMap);
			}
			// Use the entry with the highest suggestedSeconds if same date appears
			const prev = issueMap.get(s.date);
			if (
				!prev ||
				// Keep the one with more detail (longer reason = more activity)
				s.reason.length > prev.reason.length
			) {
				issueMap.set(s.date, {
					reason: s.reason,
					suggestedTimeSpent: s.suggestedTimeSpent,
				});
			}
		}

		const result: IssueActivity[] = [];
		for (const [issueKey, dateMap] of grouped) {
			const dateKeys = [...dateMap.keys()].sort();
			const entries = dateKeys.map((date) => ({
				date,
				...dateMap.get(date)!,
			}));

			// Compute total seconds from the source suggestions
			const issueSuggestions = jiraSuggestions.filter(
				(s) => s.issueKey === issueKey,
			);
			const totalSeconds = issueSuggestions.reduce(
				(sum, s) => sum + s.suggestedSeconds,
				0,
			);
			grandTotal += totalSeconds;

			result.push({
				issueKey,
				issueSummary: issueSuggestions[0]?.issueSummary,
				totalSeconds,
				entries,
			});
		}

		// Sort by most recent activity first, then by issue key
		result.sort((a, b) => {
			const aMax = a.entries[a.entries.length - 1]?.date ?? '';
			const bMax = b.entries[b.entries.length - 1]?.date ?? '';
			if (aMax !== bMax) return bMax.localeCompare(aMax);
			return a.issueKey.localeCompare(b.issueKey);
		});

		return { items: result, grandTotal };
	}, [daySummaries]);

	return (
		<Modal isOpen={isOpen} onClose={onClose} title="Recent Activity">
			<div className={styles.container}>
				{issueActivities.items.length === 0 ? (
					<div className={styles.emptyState}>
						No recent Jira activity found for this week.
					</div>
				) : (
					<>
						<ul className={styles.list} role="list">
							{issueActivities.items.map((activity) => (
								<li key={activity.issueKey} className={styles.item}>
									<div className={styles.itemHeader}>
										<span className={styles.itemKey}>
											{activity.issueKey}
										</span>
										<span className={styles.itemTotalTime}>
											{formatTotalDuration(activity.totalSeconds)}
										</span>
									</div>
									{activity.issueSummary && (
										<div className={styles.itemSummary}>
											{activity.issueSummary}
										</div>
									)}
									<div className={styles.itemDays}>
										{activity.entries.map((entry) => (
											<div
												key={`${activity.issueKey}-${entry.date}`}
												className={styles.dayEntry}
											>
												<span className={styles.dayLabel}>
													{formatDayLabel(entry.date)}
												</span>
												<span className={styles.dayReason}>
													{entry.reason}
												</span>
												<span className={styles.dayTime}>
													{entry.suggestedTimeSpent}
												</span>
											</div>
										))}
									</div>
								</li>
							))}
						</ul>
						<div className={styles.totalRow}>
							<span className={styles.totalLabel}>
								{issueActivities.items.length} issue
								{issueActivities.items.length !== 1 ? 's' : ''} — estimated
								total
							</span>
							<span className={styles.totalValue}>
								{formatTotalDuration(issueActivities.grandTotal)}
							</span>
						</div>
					</>
				)}
			</div>
		</Modal>
	);
};
