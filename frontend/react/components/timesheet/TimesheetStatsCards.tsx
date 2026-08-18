import type React from 'react';
import { useMemo } from 'react';
import type { EnrichedJiraWorklog } from '../../../../types/jira';
import { isDateInMonth } from '../../utils/date';
import { classifyWorklog } from '../../utils/worklogClassifier';
import { StatCard } from '../ui/StatCard';
import * as styles from './TimesheetStatsCards.module.css';

type Props = {
	entries: [string, Record<string, EnrichedJiraWorklog[]>][];
	year: number;
	monthZeroIndexed: number;
};

export const TimesheetStatsCards: React.FC<Props> = ({
	entries,
	year,
	monthZeroIndexed,
}) => {
	const stats = useMemo(() => {
		let totalSeconds = 0;
		let totalEntries = 0;

		for (const [, days] of entries) {
			for (const [dateKey, worklogs] of Object.entries(days)) {
				if (!isDateInMonth(dateKey, year, monthZeroIndexed)) continue;
				for (const wl of worklogs) {
					if (wl.classified?.isBackdated ?? classifyWorklog(wl).isBackdated) continue;
					totalSeconds += wl.timeSpentSeconds ?? 0;
					totalEntries++;
				}
			}
		}

		const totalHours = totalSeconds / 3600;
		const teamSize = entries.length;
		const avgHours = teamSize > 0 ? totalHours / teamSize : 0;

		return { totalHours, totalEntries, teamSize, avgHours };
	}, [entries, year, monthZeroIndexed]);

	if (entries.length === 0) return null;

	return (
		<div className={styles.grid}>
			<StatCard label="Total Hours" value={`${stats.totalHours.toFixed(1)}h`} />
			<StatCard label="Entries" value={stats.totalEntries} />
			<StatCard label="Team Size" value={stats.teamSize} />
			<StatCard label="Avg / User" value={`${stats.avgHours.toFixed(1)}h`} />
		</div>
	);
};
