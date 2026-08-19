import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import type { WorklogFetchProgress } from '../../../types/worklogLoading';
import type { WorklogItem } from '../../services/monthWorklogService';
import {
	getWorklogSource,
	type WorklogReadScope,
} from '../../services/worklogSource';
import { useConfigStore } from '../../stores/useConfigStore';
import {
	buildJiraConnectionFingerprint,
	useUIStore,
} from '../../stores/useUIStore';
import { readMonth } from './worklogReadRouter';

interface UseMonthWorklogsOptions {
	/**
	 * Whether this month's worklogs need to cover the whole team or just the
	 * signed-in user. Required because this hook serves both kinds of surface
	 * (Reports + team completeness vs the personal heatmap), and the answer
	 * decides whether Tempo may serve the read at all — see ADA-545.
	 */
	scope: WorklogReadScope;
	currentUserOnly?: boolean;
	jqlFilter?: string;
	enabled?: boolean;
	onProgress?: (progress: WorklogFetchProgress | null) => void;
	/** Prefetch adjacent months in background. Only useful for month-based navigation (timesheet, heatmap). */
	prefetchAdjacent?: boolean;
}

/** Build a query key for monthWorklogs (for use with queryClient.fetchQuery) */
export function monthWorklogsQueryKey(
	year: number,
	month: number,
	jiraHost: string,
	corsProxy: string,
	currentUserOnly: boolean,
	jqlFilter: string,
	source: 'jira' | 'tempo',
	scope: WorklogReadScope,
) {
	return [
		'monthWorklogs',
		year,
		month,
		jiraHost,
		corsProxy,
		currentUserOnly,
		jqlFilter,
		source,
		// Scope only changes the *data* on Tempo, where the two scopes hit
		// different endpoints (`worklogs/user/{id}` vs `worklogs`); sharing one
		// entry there lets whichever surface loads first win, so Reports can
		// silently render My Week's single-user rows as the whole team.
		// On Jira both scopes hit the same endpoint with the same result, so
		// they deliberately keep sharing an entry — that cross-surface
		// deduplication is why My Week and Reports don't double-fetch a month.
		source === 'tempo' ? scope : 'shared',
	];
}

export function useMonthWorklogs(
	year: number,
	month: number,
	options: UseMonthWorklogsOptions,
) {
	const config = useConfigStore((s) => s.config);
	const tempoSuspected = useUIStore((s) => s.tempoSuspected);
	const source = getWorklogSource({
		tempoMode: config.tempoMode,
		tempoApiToken: config.tempoApiToken,
		tempoSuspected,
		scope: options.scope,
	});
	const queryClient = useQueryClient();
	const jiraHost = config.jiraHost;
	const apiToken = config.apiToken;
	const corsProxy = config.corsProxy;
	const currentUserOnly = options.currentUserOnly ?? false;
	const jqlFilter = options.jqlFilter ?? '';
	const onProgress = options.onProgress;

	const result = useQuery<WorklogItem[]>({
		queryKey: monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			currentUserOnly,
			jqlFilter,
			source,
			options.scope,
		),
		queryFn: ({ signal }) =>
			readMonth(
				source,
				config,
				year,
				month,
				{
					currentUserOnly,
					jqlFilter: options.jqlFilter,
					onProgress: onProgress ?? undefined,
					scope: options.scope,
				},
				signal,
			),
		enabled: (options.enabled ?? true) && !!jiraHost && !!apiToken,
		staleTime: 15 * 60 * 1000,
	});

	// Prefetch adjacent months in background (opt-in, useful for month navigation)
	const prefetchAdjacent = options.prefetchAdjacent ?? false;
	const queryConfig = useMemo(
		() => ({
			...config,
			jiraHost,
			apiToken,
			corsProxy,
		}),
		[config, jiraHost, apiToken, corsProxy],
	);
	useEffect(() => {
		if (!result.isFetching) {
			onProgress?.(null);
		}
	}, [result.isFetching, onProgress]);

	useEffect(() => {
		if (!result.isSuccess || result.dataUpdatedAt <= 0) return;

		useUIStore
			.getState()
			.markJiraConnectionEvidence(
				buildJiraConnectionFingerprint(config),
				'fetch',
			);
	}, [config, result.dataUpdatedAt, result.isSuccess]);

	useEffect(() => {
		if (!prefetchAdjacent || !jiraHost || !apiToken) return;

		const prevMonth = month === 0 ? 11 : month - 1;
		const prevYear = month === 0 ? year - 1 : year;
		const nextMonth = month === 11 ? 0 : month + 1;
		const nextYear = month === 11 ? year + 1 : year;

		for (const [y, m] of [
			[prevYear, prevMonth],
			[nextYear, nextMonth],
		]) {
			queryClient.prefetchQuery({
				queryKey: monthWorklogsQueryKey(
					y,
					m,
					jiraHost,
					corsProxy,
					currentUserOnly,
					jqlFilter,
					source,
					options.scope,
				),
				queryFn: ({ signal }) =>
					readMonth(
						source,
						queryConfig,
						y,
						m,
						{
							currentUserOnly,
							jqlFilter: options.jqlFilter,
							scope: options.scope,
						},
						signal,
					),
				staleTime: 15 * 60 * 1000,
			});
		}
	}, [
		prefetchAdjacent,
		year,
		month,
		queryConfig,
		jiraHost,
		apiToken,
		corsProxy,
		currentUserOnly,
		jqlFilter,
		queryClient,
		options.jqlFilter,
		// Routing source (ADA-543): the prefetch key and `readMonth` both branch on
		// it, so a jira→tempo flip must re-run this effect or adjacent months stay
		// prefetched under the previous source's key.
		source,
		// Scope picks the per-user vs team Tempo endpoint (ADA-545); prefetching
		// under a stale scope would cache one user's rows as the team's.
		options.scope,
	]);

	return result;
}
