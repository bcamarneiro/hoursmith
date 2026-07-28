import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import type { WorklogFetchProgress } from '../../../types/worklogLoading';
import type { EnrichedJiraWorklog } from '../../../types/jira';
import {
	fetchMonthWorklogs,
	type WorklogItem,
} from '../../services/monthWorklogService';
import {
	buildConnectionScope,
	getCachedWorklogs,
	storeWorklogs,
	isIndexedDBAvailable,
} from '../../services/worklogCache';
import { useConfigStore } from '../../stores/useConfigStore';
import {
	buildJiraConnectionFingerprint,
	useUIStore,
} from '../../stores/useUIStore';

interface UseMonthWorklogsOptions {
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
) {
	return [
		'monthWorklogs',
		year,
		month,
		jiraHost,
		corsProxy,
		currentUserOnly,
		jqlFilter,
	];
}

export function useMonthWorklogs(
	year: number,
	month: number,
	options?: UseMonthWorklogsOptions,
) {
	const config = useConfigStore((s) => s.config);
	const queryClient = useQueryClient();
	const jiraHost = config.jiraHost;
	const apiToken = config.apiToken;
	const corsProxy = config.corsProxy;
	const currentUserOnly = options?.currentUserOnly ?? false;
	const jqlFilter = options?.jqlFilter ?? '';
	const onProgress = options?.onProgress;
	const cacheEnabled = config.worklogCacheEnabled === true;
	const connectionScope = buildConnectionScope(jiraHost, config.email);

	// Track whether we've already seeded from cache for this query key
	// to avoid re-seeding on every render.
	const seededKeyRef = useRef<string | null>(null);

	// Build initial data from IndexedDB cache if enabled
	const cacheQueryKey = `${connectionScope}::${year}-${month}`;
	const initialData = useMemo(() => {
		if (!cacheEnabled || !isIndexedDBAvailable()) return undefined;
		// We can't do async initial data in useMemo, so we use the
		// queryClient cache as a bridge — see the useEffect below.
		return undefined;
	}, [cacheEnabled, connectionScope, year, month]);

	const result = useQuery<WorklogItem[]>({
		queryKey: monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			currentUserOnly,
			jqlFilter,
		),
		queryFn: async ({ signal }) => {
			const worklogs = await fetchMonthWorklogs(
				config,
				year,
				month,
				{
					currentUserOnly,
					jqlFilter: options?.jqlFilter,
					onProgress: onProgress ?? undefined,
				},
				signal,
			);

			// Persist to IndexedDB if cache is enabled
			if (cacheEnabled && isIndexedDBAvailable()) {
				await storeWorklogs(connectionScope, year, month, worklogs);
			}

			return worklogs;
		},
		enabled: (options?.enabled ?? true) && !!jiraHost && !!apiToken,
		staleTime: 15 * 60 * 1000,
	});

	// Seed React Query cache from IndexedDB on mount (when cache enabled)
	useEffect(() => {
		if (!cacheEnabled || !isIndexedDBAvailable()) return;
		if (!jiraHost || !apiToken) return;
		if (seededKeyRef.current === cacheQueryKey) return;

		// Only seed if React Query doesn't already have fresh data
		const queryKey = monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			currentUserOnly,
			jqlFilter,
		);
		const existing = queryClient.getQueryData(queryKey);
		if (existing && Array.isArray(existing) && existing.length > 0) {
			seededKeyRef.current = cacheQueryKey;
			return;
		}

		getCachedWorklogs(connectionScope, year, month).then((cached) => {
			if (cached && cached.worklogs.length > 0) {
				queryClient.setQueryData(queryKey, cached.worklogs);
				seededKeyRef.current = cacheQueryKey;
			}
		});
	}, [
		cacheEnabled,
		cacheQueryKey,
		connectionScope,
		year,
		month,
		jiraHost,
		apiToken,
		corsProxy,
		currentUserOnly,
		jqlFilter,
		queryClient,
	]);

	// Prefetch adjacent months in background (opt-in, useful for month navigation)
	const prefetchAdjacent = options?.prefetchAdjacent ?? false;
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
				),
				queryFn: async ({ signal }) => {
					const worklogs = await fetchMonthWorklogs(
						queryConfig,
						y,
						m,
						{
							currentUserOnly,
							jqlFilter: options?.jqlFilter,
						},
						signal,
					);
					if (cacheEnabled && isIndexedDBAvailable()) {
						await storeWorklogs(buildConnectionScope(jiraHost, config.email), y, m, worklogs);
					}
					return worklogs;
				},
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
		options?.jqlFilter,
		cacheEnabled,
		config.email,
	]);

	return result;
}
