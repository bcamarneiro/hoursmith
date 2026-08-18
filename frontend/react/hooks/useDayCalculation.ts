import { useMemo } from 'react';
import type { JiraWorklog } from '../../../types/JiraWorklog';
import { computeDayTargetSeconds } from '../utils/dayTarget';
import { classifyWorklog } from '../utils/worklogClassifier';

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
			if (wl.classified?.isBackdated ?? classifyWorklog(wl).isBackdated) {
				backdatedSeconds += seconds;
			} else {
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
