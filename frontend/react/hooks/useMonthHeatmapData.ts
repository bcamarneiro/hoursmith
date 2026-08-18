import { useMemo, useState, useEffect, useRef } from 'react';
import type { EnrichedJiraWorklog } from '../../../types/jira';
import { useConfigStore } from '../../stores/useConfigStore';
import { useDashboardStore } from '../../stores/useDashboardStore';
import { getWeekMonthAnchor } from '../utils/date';
import { classifyWorklog } from '../utils/worklogClassifier';
import { useMonthWorklogs } from './useMonthWorklogs';
import {
	isProcessingWorkerSupported,
	postToWorker,
} from '../../workers/processingWorkerClient';
import type { HeatmapResult } from '../../workers/processingWorker.types';

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

	const { data: worklogs, isLoading: fetchLoading } = useMonthWorklogs(year, month, {
		jqlFilter: jqlFilter?.trim() || undefined,
		prefetchAdjacent: true,
	});

	// Worker-based async computation with sync fallback
	const [buckets, setBuckets] = useState<MonthHeatmapBuckets>(() => ({
		data: new Map(),
		backdatedSeconds: new Map(),
	}));
	const [workerLoading, setWorkerLoading] = useState(false);
	const requestId = useRef(0);

	useEffect(() => {
		if (!worklogs) {
			setBuckets({ data: new Map(), backdatedSeconds: new Map() });
			return;
		}

		const thisRequest = ++requestId.current;

		// If worker is not available, compute synchronously
		if (!isProcessingWorkerSupported()) {
			setBuckets(buildMonthHeatmapBuckets(worklogs, email));
			return;
		}

		setWorkerLoading(true);

		postToWorker({
			type: 'buildHeatmap',
			payload: { worklogs, email },
		})
			.then((response) => {
				if (thisRequest !== requestId.current) return;
				if (response.type === 'buildHeatmap') {
					const hr = response.result as HeatmapResult;
					setBuckets({
						data: new Map(Object.entries(hr.data)),
						backdatedSeconds: new Map(Object.entries(hr.backdatedSeconds)),
					});
				} else {
					// Error response — fall back to sync
					setBuckets(buildMonthHeatmapBuckets(worklogs, email));
				}
			})
			.catch(() => {
				if (thisRequest !== requestId.current) return;
				setBuckets(buildMonthHeatmapBuckets(worklogs, email));
			})
			.finally(() => {
				if (thisRequest !== requestId.current) return;
				setWorkerLoading(false);
			});
	}, [worklogs, email]);

	const isLoading = fetchLoading || workerLoading;

	return { data: buckets.data, backdatedSeconds: buckets.backdatedSeconds, isLoading, month, year };
}
