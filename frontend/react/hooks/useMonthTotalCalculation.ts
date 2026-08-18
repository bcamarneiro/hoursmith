import { useMemo } from 'react';
import type { JiraWorklog } from '../../../types/JiraWorklog';
import { isDateInMonth } from '../utils/date';
import { shouldSkipWorklog } from '../utils/worklogFilter';

export function useMonthTotalCalculation(
	days: Record<string, JiraWorklog[]>,
	currentYear: number,
	currentMonth: number,
) {
	const totalSeconds = useMemo(() => {
		let userTotalSeconds = 0;

		for (const [dateKey, dayWorklogs] of Object.entries(days)) {
			if (!isDateInMonth(dateKey, currentYear, currentMonth)) {
				continue;
			}
			for (const wl of dayWorklogs) {
				if (shouldSkipWorklog(wl).skip) continue;
				userTotalSeconds += wl.timeSpentSeconds ?? 0;
			}
		}

		return userTotalSeconds;
	}, [days, currentYear, currentMonth]);

	return { totalSeconds };
}
