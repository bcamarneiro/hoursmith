import { useMemo } from 'react';
import type { JiraWorklog } from '../../../types/JiraWorklog';
import { isDateInMonth } from '../utils/date';
import { classifyWorklog } from '../utils/worklogClassifier';

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
					if (wl.classified?.isBackdated ?? classifyWorklog(wl).isBackdated) continue;
				userTotalSeconds += wl.timeSpentSeconds ?? 0;
			}
		}

		return userTotalSeconds;
	}, [days, currentYear, currentMonth]);

	return { totalSeconds };
}
