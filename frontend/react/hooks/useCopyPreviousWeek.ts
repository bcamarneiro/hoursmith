import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { WorklogSuggestion } from '../../../types/Suggestion';
import {
	fetchMonthWorklogs,
	type WorklogItem,
} from '../../services/monthWorklogService';
import { useConfigStore } from '../../stores/useConfigStore';
import { useDashboardStore } from '../../stores/useDashboardStore';
import { addDaysToIsoDate } from '../utils/date';
import { classifyWorklog } from '../utils/worklogClassifier';
import { monthWorklogsQueryKey } from './useMonthWorklogs';

/**
 * Given a date string, shift it forward by 7 days and return the new date string.
 */
function shiftDateByWeek(dateStr: string): string {
	return addDaysToIsoDate(dateStr, 7);
}

function formatTimeSpent(seconds: number): string {
	const hours = seconds / 3600;
	if (hours >= 1) {
		const h = Math.floor(hours);
		const remaining = seconds % 3600;
		return remaining > 0 ? `${h}h ${Math.round(remaining / 60)}m` : `${h}h`;
	}
	return `${Math.round(seconds / 60)}m`;
}

/**
 * Get the Monday of the previous week given the current week's Monday.
 */
function getPreviousWeekStart(weekStart: string): string {
	return addDaysToIsoDate(weekStart, -7);
}

function getPreviousWeekEnd(prevWeekStart: string): string {
	return addDaysToIsoDate(prevWeekStart, 6);
}

/** Derive week worklogs from month data, bucketed by classifier-derived logged-policy day. */
export function deriveWeekWorklogs(
	worklogs: WorklogItem[],
	email: string,
	weekStart: string,
	weekEnd: string,
) {
	const lowerEmail = email.toLowerCase();
	const entries: {
		date: string;
		issueKey: string;
		issueSummary?: string;
		timeSpentSeconds: number;
	}[] = [];

	for (const wl of worklogs) {
		if (wl.author?.emailAddress?.toLowerCase() !== lowerEmail) continue;
		// Skip backdated submissions entirely — they don't represent recurring
		// work for that week and shouldn't seed next-week suggestions.
		const c = wl.classified ?? classifyWorklog(wl);
		if (c.isBackdated) continue;
		const day = c.loggedOn;
		if (day && day >= weekStart && day <= weekEnd) {
			entries.push({
				date: day,
				issueKey: wl.issue.key,
				issueSummary: wl.issue.fields.summary as string,
				timeSpentSeconds: wl.timeSpentSeconds ?? 0,
			});
		}
	}

	return entries;
}

export function useCopyPreviousWeek() {
	const config = useConfigStore((s) => s.config);
	const weekStart = useDashboardStore((s) => s.weekStart);
	const mergePreviousWeekSuggestions = useDashboardStore(
		(s) => s.mergePreviousWeekSuggestions,
	);
	const [isLoading, setIsLoading] = useState(false);
	const queryClient = useQueryClient();

	const copyPreviousWeek = async () => {
		if (!config.jiraHost || !config.apiToken) return 0;

		setIsLoading(true);
		try {
			const prevStart = getPreviousWeekStart(weekStart);
			const prevEnd = getPreviousWeekEnd(prevStart);

			// Determine which month(s) the previous week spans
			const [startYear, startMonthStr] = prevStart.split('-').map(Number);
			const [endYear, endMonthStr] = prevEnd.split('-').map(Number);
			const startMonth = startMonthStr - 1;
			const endMonth = endMonthStr - 1;
			const jqlFilter = config.jqlFilter?.trim() || '';
			const fetchOpts = {
				jqlFilter: jqlFilter || undefined,
			};
			const buildKey = (y: number, m: number) =>
				monthWorklogsQueryKey(
					y,
					m,
					config.jiraHost,
					config.corsProxy,
					false,
					jqlFilter,
				);

			const month1Data = await queryClient.fetchQuery({
				queryKey: buildKey(startYear, startMonth),
				queryFn: ({ signal }) =>
					fetchMonthWorklogs(config, startYear, startMonth, fetchOpts, signal),
				staleTime: 15 * 60 * 1000,
			});

			let allData = month1Data;
			if (startYear !== endYear || startMonth !== endMonth) {
				const month2Data = await queryClient.fetchQuery({
					queryKey: buildKey(endYear, endMonth),
					queryFn: ({ signal }) =>
						fetchMonthWorklogs(config, endYear, endMonth, fetchOpts, signal),
					staleTime: 15 * 60 * 1000,
				});
				allData = [...month1Data, ...month2Data];
			}

			const prevWorklogs = deriveWeekWorklogs(
				allData,
				config.email,
				prevStart,
				prevEnd,
			);

			if (prevWorklogs.length === 0) return 0;

			// Group worklogs by (dayOfWeek, issueKey) and aggregate time
			const grouped = new Map<
				string,
				{
					issueKey: string;
					issueSummary?: string;
					date: string;
					totalSeconds: number;
				}
			>();

			for (const wl of prevWorklogs) {
				const key = `${wl.date}::${wl.issueKey}`;
				const existing = grouped.get(key);
				if (existing) {
					existing.totalSeconds += wl.timeSpentSeconds;
				} else {
					grouped.set(key, {
						issueKey: wl.issueKey,
						issueSummary: wl.issueSummary,
						date: wl.date,
						totalSeconds: wl.timeSpentSeconds,
					});
				}
			}

			// Map each previous-week entry to the corresponding day of the current week
			const suggestions: WorklogSuggestion[] = [];

			for (const entry of grouped.values()) {
				const currentDate = shiftDateByWeek(entry.date);
				suggestions.push({
					id: `prev-week-${entry.issueKey}-${currentDate}`,
					source: 'previous-week',
					issueKey: entry.issueKey,
					issueSummary: entry.issueSummary,
					date: currentDate,
					suggestedTimeSpent: formatTimeSpent(entry.totalSeconds),
					suggestedSeconds: entry.totalSeconds,
					confidence: 'medium',
					reason: 'Logged last week on the same day',
					logged: false,
				});
			}

			mergePreviousWeekSuggestions(suggestions);
			return suggestions.length;
		} finally {
			setIsLoading(false);
		}
	};

	return { copyPreviousWeek, isLoading };
}
