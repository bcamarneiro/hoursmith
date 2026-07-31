import type React from 'react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { describeServiceError } from '../../../services/serviceErrors';
import { useConfigStore } from '../../../stores/useConfigStore';
import type { JiraActivityItem } from '../../../types/activity';
import { useJiraActivity } from '../../hooks/useJiraActivity';
import { isWeekend, parseIsoDateLocal } from '../../utils/date';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import * as styles from './RecentActivityPanel.module.css';

const WEEKDAY_LABELS = [
	'Sun',
	'Mon',
	'Tue',
	'Wed',
	'Thu',
	'Fri',
	'Sat',
] as const;
const MONTH_LABELS = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
] as const;

interface RecentActivityPanelProps {
	weekStart: string;
	weekEnd: string;
}

/**
 * Recent Jira activity for the current user in the given week (ADA-654 UI):
 * status transitions and comments, grouped by day.
 *
 * Consumes `useJiraActivity`, which shares the TanStack Query cache with the
 * dashboard fetcher, so this panel never triggers a second fetch for data the
 * dashboard already loaded. Renders distinct nudge (Jira not configured),
 * loading, error, empty and populated states.
 */
export const RecentActivityPanel: React.FC<RecentActivityPanelProps> = ({
	weekStart,
	weekEnd,
}) => {
	const config = useConfigStore((s) => s.config);
	const jiraConfigured = !!config.jiraHost && !!config.apiToken;
	const { data, isLoading, isError, error, refetch } = useJiraActivity(
		weekStart,
		weekEnd,
	);

	// Newest day first, then issue key, for a stable reading order.
	const items = useMemo(() => {
		if (!data) return [];
		return [...data].sort(
			(a, b) =>
				b.date.localeCompare(a.date) || a.issueKey.localeCompare(b.issueKey),
		);
	}, [data]);

	const days = useMemo(() => {
		const groups = new Map<string, JiraActivityItem[]>();
		for (const item of items) {
			const list = groups.get(item.date);
			if (list) list.push(item);
			else groups.set(item.date, [item]);
		}
		return [...groups.entries()];
	}, [items]);

	if (!jiraConfigured) {
		return (
			<section className={styles.panel} aria-label="Recent activity">
				<h3 className={styles.title}>Recent activity</h3>
				<p className={styles.note}>
					Connect Jira to see your recent status transitions and comments.{' '}
					<Link className={styles.noteLink} to="/settings">
						Open Settings
					</Link>
				</p>
			</section>
		);
	}

	if (isLoading && items.length === 0) {
		return (
			<section className={styles.panel} aria-label="Recent activity">
				<h3 className={styles.title}>Recent activity</h3>
				<output className={styles.status} aria-live="polite">
					<Spinner size="sm" />
					<span>Loading recent activity…</span>
				</output>
			</section>
		);
	}

	if (isError && items.length === 0) {
		const copy = describeServiceError(error);
		return (
			<section className={styles.panel} aria-label="Recent activity">
				<h3 className={styles.title}>Recent activity</h3>
				<output
					className={`${styles.status} ${styles.statusError}`}
					aria-live="polite"
				>
					<span>{copy.message}</span>
					<Button variant="secondary" onClick={() => void refetch()}>
						Retry
					</Button>
				</output>
			</section>
		);
	}

	if (items.length === 0) {
		return (
			<section className={styles.panel} aria-label="Recent activity">
				<h3 className={styles.title}>Recent activity</h3>
				<p className={styles.note}>No Jira activity this week.</p>
			</section>
		);
	}

	return (
		<section className={styles.panel} aria-label="Recent activity">
			<div className={styles.header}>
				<h3 className={styles.title}>Recent activity</h3>
				<span className={styles.summary}>
					<span className={styles.num}>{items.length}</span> issue
					{items.length === 1 ? '' : 's'}
				</span>
			</div>
			<ul className={styles.list}>
				{days.map(([date, dayItems]) => (
					<li key={date} className={styles.dayGroup}>
						<div className={styles.dayHeader}>
							<span
								className={
									isWeekend(date)
										? `${styles.dayLabel} ${styles.dayLabelWeekend}`
										: styles.dayLabel
								}
							>
								{formatDayLabel(date)}
							</span>
							<span className={`${styles.num} ${styles.dayCount}`}>
								{dayItems.length}
							</span>
						</div>
						<ul className={styles.dayList}>
							{dayItems.map((item) => (
								<li
									key={`${item.date}-${item.issueKey}`}
									className={styles.row}
								>
									<span className={`${styles.num} ${styles.issueKey}`}>
										{item.issueKey}
									</span>
									<span
										className={styles.issueSummary}
										title={item.issueSummary}
									>
										{item.issueSummary ?? '(no summary)'}
									</span>
									<span className={styles.badges}>
										{item.transitions > 0 && (
											<span
												className={`${styles.num} ${styles.badge} ${styles.badgeTransitions}`}
											>
												{item.transitions} transition
												{item.transitions === 1 ? '' : 's'}
											</span>
										)}
										{item.comments > 0 && (
											<span
												className={`${styles.num} ${styles.badge} ${styles.badgeComments}`}
											>
												{item.comments} comment
												{item.comments === 1 ? '' : 's'}
											</span>
										)}
									</span>
								</li>
							))}
						</ul>
					</li>
				))}
			</ul>
		</section>
	);
};

/** Deterministic "Wed, Oct 15" label so rendering never depends on locale. */
function formatDayLabel(dateStr: string): string {
	const date = parseIsoDateLocal(dateStr);
	return `${WEEKDAY_LABELS[date.getDay()]}, ${MONTH_LABELS[date.getMonth()]} ${date.getDate()}`;
}
