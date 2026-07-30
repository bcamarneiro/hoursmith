import { useMemo } from 'react';
import type { JiraWorklog } from '../../../types/JiraWorklog';
import { computeDayTargetSeconds } from '../utils/dayTarget';
import { shouldSkipWorklog } from '../utils/worklogFilter';

export function useDayCalculation(
	worklogs: JiraWorklog[],
	isWeekend: boolean,
	isAbsent = false,
) {
	const calculations = useMemo(() => {
		let countedSeconds = 0;
		let backdatedSeconds = 0;
		for (const wl of worklogs) {
			const seconds = wl.timeSpentSeconds ?? 0;
			const { skip, reason } = shouldSkipWorklog(wl);
			if (skip && reason === 'backdated') {
				backdatedSeconds += seconds;
			} else if (!skip) {
				countedSeconds += seconds;
			}
		}

		const baselineSeconds = computeDayTargetSeconds(
			isWeekend,
			isAbsent,
			countedSeconds,
		);
		const dayTotalSeconds = countedSeconds;
		const effectiveSeconds = countedSeconds;
		const missingSeconds = Math.max(0, baselineSeconds - effectiveSeconds);

		return {
			dayTotalSeconds,
			backdatedSeconds,
			baselineSeconds,
			effectiveSeconds,
			missingSeconds,
		};
	}, [worklogs, isWeekend, isAbsent]);

	return calculations;
}
