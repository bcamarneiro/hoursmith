import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import type { WorklogFetchProgress } from '../../../types/worklogLoading';
import {
	fetchMonthWorklogs,
	type WorklogItem,
} from '../../services/monthWorklogService';
import {
	clearConnectionCache,
	loadMonthWorklogs,
	saveMonthWorklogs,
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
	const cacheEnabled = config.worklogCacheEnabled;

	const queryKey = monthWorklogsQueryKey(
		year,
		month,
		jiraHost,
		corsProxy,
		currentUserOnly,
		jqlFilter,
	);

	// Pre-populate React Query cache from IndexedDB on mount for instant reloads.
	// The network fetch still runs (React Query handles staleness), but the UI
	// shows cached data immediately instead of a loading spinner.
	useEffect(() => {
		if (!cacheEnabled || !jiraHost || !apiToken) return;

		const fingerprint = buildJiraConnectionFingerprint(config);
		let cancelled = false;

		loadMonthWorklogs(fingerprint, year, month).then((cached) => {
			if (cancelled || !cached) return;
			// Only pre-populate if the query has no data yet
			const existing = queryClient.getQueryData(queryKey);
			if (!existing) {
				queryClient.setQueryData(queryKey, cached);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [cacheEnabled, jiraHost, apiToken, config, year, month, queryClient, queryKey]);

	const result = useQuery<WorklogItem[]>({
		queryKey,
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

			// Persist to IndexedDB after successful fetch (opt-in)
			if (cacheEnabled) {
				const fingerprint = buildJiraConnectionFingerprint(config);
				saveMonthWorklogs(fingerprint, year, month, worklogs).catch(() => {
					// Cache write failure is non-fatal — the data is already in
					// the React Query cache and the UI is unaffected.
				});
			}

			return worklogs;
		},
		enabled: (options?.enabled ?? true) && !!jiraHost && !!apiToken,
		staleTime: 15 * 60 * 1000,
	});

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

					if (cacheEnabled) {
						const fingerprint = buildJiraConnectionFingerprint(queryConfig);
						saveMonthWorklogs(fingerprint, y, m, worklogs).catch(() => {});
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
	]);

	return result;
}

/**
 * Clear the IndexedDB worklog cache for the current connection.
 * Exposed for use in settings / sign-out flows.
 */
export async function clearWorklogCacheForConnection(
	config: Pick<
		Parameters<typeof buildJiraConnectionFingerprint>[0],
		'jiraHost' | 'email' | 'apiToken' | 'corsProxy'
	>,
): Promise<void> {
	const fingerprint = buildJiraConnectionFingerprint(config);
	await clearConnectionCache(fingerprint);
}
