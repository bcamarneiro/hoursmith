import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { EnrichedJiraWorklog } from '../../../types/jira';
import type { WorklogFetchProgress } from '../../../types/worklogLoading';
import { getWorklogSource } from '../../services/worklogSource';
import { useConfigStore } from '../../stores/useConfigStore';
import { useTimesheetStore } from '../../stores/useTimesheetStore';
import { useUIStore } from '../../stores/useUIStore';
import { monthWorklogsQueryKey, useMonthWorklogs } from './useMonthWorklogs';

function adjacentMonths(year: number, month: number) {
	const prev =
		month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
	const next =
		month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
	return { prev, next };
}

/**
 * Fetches the visible month and merges any prefetched adjacent months from
 * the query cache. The wider window gives the day projector the data it
 * needs to render ghost entries for backdated worklogs whose `started`
 * date falls in an adjacent month.
 *
 * Adjacent months are fetched in the background via `prefetchAdjacent` —
 * they never gate the UI. If they arrive after the calendar has rendered,
 * the store updates and ghosts appear automatically.
 */
export function useTimesheetDataFetcher(options?: { enabled?: boolean }) {
	const enabled = options?.enabled ?? true;
	const currentYear = useTimesheetStore((state) => state.currentYear);
	const currentMonth = useTimesheetStore((state) => state.currentMonth);
	const setData = useTimesheetStore((state) => state.setData);
	const jqlFilter = useConfigStore((state) => state.config.jqlFilter);
	const jiraHost = useConfigStore((state) => state.config.jiraHost);
	const corsProxy = useConfigStore((state) => state.config.corsProxy);
	const tempoMode = useConfigStore((state) => state.config.tempoMode);
	const tempoApiToken = useConfigStore((state) => state.config.tempoApiToken);
	const tempoSuspected = useUIStore((s) => s.tempoSuspected);
	const source = getWorklogSource({
		tempoMode,
		tempoApiToken,
		tempoSuspected,
		// Must match the scope useMonthWorklogs resolves below, or the
		// monthWorklogsQueryKey cache lookups in this hook miss. See ADA-545.
		scope: 'team',
	});
	const queryClient = useQueryClient();
	const [worklogProgress, setWorklogProgress] =
		useState<WorklogFetchProgress | null>(null);

	const { prev, next } = useMemo(
		() => adjacentMonths(currentYear, currentMonth),
		[currentYear, currentMonth],
	);

	const mainQuery = useMonthWorklogs(currentYear, currentMonth, {
		scope: 'team',
		jqlFilter: jqlFilter || undefined,
		prefetchAdjacent: enabled,
		enabled,
		onProgress: setWorklogProgress,
	});

	useEffect(() => {
		const main = mainQuery.data;
		if (!main) return;

		const prevKey = monthWorklogsQueryKey(
			prev.year,
			prev.month,
			jiraHost,
			corsProxy,
			false,
			jqlFilter || '',
			source,
			'team',
		);
		const nextKey = monthWorklogsQueryKey(
			next.year,
			next.month,
			jiraHost,
			corsProxy,
			false,
			jqlFilter || '',
			source,
			'team',
		);
		const prevData =
			(queryClient.getQueryData(prevKey) as
				| EnrichedJiraWorklog[]
				| undefined) ?? undefined;
		const nextData =
			(queryClient.getQueryData(nextKey) as
				| EnrichedJiraWorklog[]
				| undefined) ?? undefined;

		const merged: EnrichedJiraWorklog[] = [];
		const seen = new Set<string>();
		for (const list of [main, prevData, nextData]) {
			if (!list) continue;
			for (const wl of list as EnrichedJiraWorklog[]) {
				const key = wl.id ?? '';
				if (key && seen.has(key)) continue;
				if (key) seen.add(key);
				merged.push(wl);
			}
		}
		setData(merged);
	}, [
		mainQuery.data,
		queryClient,
		prev.year,
		prev.month,
		next.year,
		next.month,
		jiraHost,
		corsProxy,
		jqlFilter,
		source,
		setData,
	]);

	// Re-merge when adjacent months arrive in the cache. We subscribe to the
	// queryClient to pick up adjacent-month landings without forcing them as
	// gating queries.
	useEffect(() => {
		if (!mainQuery.data) return;
		const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
			if (event?.type !== 'updated') return;
			const key = event.query.queryKey;
			if (!Array.isArray(key) || key[0] !== 'monthWorklogs') return;
			const matchesPrev = key[1] === prev.year && key[2] === prev.month;
			const matchesNext = key[1] === next.year && key[2] === next.month;
			if (!matchesPrev && !matchesNext) return;
			const main = mainQuery.data;
			if (!main) return;

			const prevKey = monthWorklogsQueryKey(
				prev.year,
				prev.month,
				jiraHost,
				corsProxy,
				false,
				jqlFilter || '',
				source,
				'team',
			);
			const nextKey = monthWorklogsQueryKey(
				next.year,
				next.month,
				jiraHost,
				corsProxy,
				false,
				jqlFilter || '',
				source,
				'team',
			);
			const prevData = queryClient.getQueryData(prevKey) as
				| EnrichedJiraWorklog[]
				| undefined;
			const nextData = queryClient.getQueryData(nextKey) as
				| EnrichedJiraWorklog[]
				| undefined;

			const merged: EnrichedJiraWorklog[] = [];
			const seen = new Set<string>();
			for (const list of [main, prevData, nextData]) {
				if (!list) continue;
				for (const wl of list) {
					const k = wl.id ?? '';
					if (k && seen.has(k)) continue;
					if (k) seen.add(k);
					merged.push(wl);
				}
			}
			setData(merged);
		});
		return unsubscribe;
	}, [
		mainQuery.data,
		queryClient,
		prev.year,
		prev.month,
		next.year,
		next.month,
		jiraHost,
		corsProxy,
		jqlFilter,
		source,
		setData,
	]);

	return {
		...mainQuery,
		errorMessage: mainQuery.error
			? mainQuery.error instanceof Error
				? `Failed to fetch data from Jira: ${mainQuery.error.message}`
				: 'An unknown error occurred.'
			: null,
		worklogProgress,
	};
}
