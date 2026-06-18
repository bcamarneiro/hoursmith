import { useMemo } from 'react';
import type { EnrichedJiraWorklog } from '../../../types/jira';
import { useConfigStore } from '../../stores/useConfigStore';
import { useDashboardStore } from '../../stores/useDashboardStore';
import { getWeekMonthAnchor } from '../utils/date';
import { classifyWorklog } from '../utils/worklogClassifier';
import { useMonthWorklogs } from './useMonthWorklogs';

interface MonthHeatmapBuckets {
	data: Map<string, number>;
	backdatedSeconds: Map<string, number>;
}

/**
 * Pure helper: bucket worklogs into per-day totals and per-day backdated
 * totals using the classifier. Exported for unit testing.
 */
export function buildMonthHeatmapBuckets(
	worklogs: EnrichedJiraWorklog[] | undefined,
	email: string,
): MonthHeatmapBuckets {
	const dayMap = new Map<string, number>();
	const backdated = new Map<string, number>();
	if (!worklogs) return { data: dayMap, backdatedSeconds: backdated };

	const lowerEmail = email.toLowerCase();

	for (const wl of worklogs) {
		if (wl.author?.emailAddress?.toLowerCase() !== lowerEmail) continue;
		const c = classifyWorklog(wl);
		const day = c.loggedOn;
		const seconds = wl.timeSpentSeconds ?? 0;
		if (day) {
			if (c.isBackdated) {
				// Backdated entries don't contribute to the cell total — they
				// only feed the overlay stripe. Matches the day-cell rule in
				// useDayCalculation.
				backdated.set(day, (backdated.get(day) ?? 0) + seconds);
			} else {
				dayMap.set(day, (dayMap.get(day) ?? 0) + seconds);
			}
		}
	}
	return { data: dayMap, backdatedSeconds: backdated };
}

interface MonthHeatmapResult {
	data: Map<string, number>;
	/**
	 * Per-day backdated seconds — NOT counted in `data`. Drives a stripe
	 * overlay on the heatmap so users can see "this day has backdated
	 * submissions" without inflating the cell's total/colour intensity.
	 */
	backdatedSeconds: Map<string, number>;
	isLoading: boolean;
	month: number;
	year: number;
}

export function useMonthHeatmapData(): MonthHeatmapResult {
	const weekStart = useDashboardStore((s) => s.weekStart);
	const email = useConfigStore((s) => s.config.email);
	const jqlFilter = useConfigStore((s) => s.config.jqlFilter);
	// Anchor the heatmap month on the week's "majority" month (its Thursday),
	// not the Monday — otherwise a week straddling a month boundary whose
	// Monday is still in the previous month shows the wrong month (ADA-457/463).
	const { year, month } = getWeekMonthAnchor(weekStart);

	const { data: worklogs, isLoading } = useMonthWorklogs(year, month, {
		jqlFilter: jqlFilter?.trim() || undefined,
		prefetchAdjacent: true,
	});

	const { data, backdatedSeconds } = useMemo(
		() => buildMonthHeatmapBuckets(worklogs, email),
		[worklogs, email],
	);

	return { data, backdatedSeconds, isLoading, month, year };
}
