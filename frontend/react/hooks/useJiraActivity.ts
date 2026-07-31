import { useQuery } from '@tanstack/react-query';
import { fetchRecentActivity } from '../../services/jiraActivityService';
import { useConfigStore } from '../../stores/useConfigStore';
import type { JiraActivityItem } from '../../types/activity';
import { useEffectiveProxyUrl } from './useEffectiveProxyUrl';

/** Build the cache key for the recent-activity fetch (shared with fetchQuery callers). */
export function jiraActivityQueryKey(
	jiraHost: string,
	corsProxy: string,
	weekStart: string,
	weekEnd: string,
	email: string,
) {
	return ['jiraActivity', jiraHost, corsProxy, weekStart, weekEnd, email];
}

interface UseJiraActivityOptions {
	enabled?: boolean;
}

/**
 * Recent Jira activity (status transitions + comments) for the current user
 * in the given week, as normalized `JiraActivityItem[]`.
 *
 * Exposes the standard TanStack Query loading/error surface: `data`,
 * `isLoading`, `isError`, `error`, `refetch`. The fetch is disabled (and the
 * cache left empty) when Jira is not configured.
 */
export function useJiraActivity(
	weekStart: string,
	weekEnd: string,
	options?: UseJiraActivityOptions,
) {
	const config = useConfigStore((s) => s.config);
	const jiraHost = config.jiraHost;
	const apiToken = config.apiToken;
	// Jira requests use the effective proxy URL (auto-resolves to the hosted
	// Premium endpoint when entitled — ADA-273), matching the dashboard fetcher.
	const corsProxy = useEffectiveProxyUrl();

	const email = config.email;

	return useQuery<JiraActivityItem[]>({
		queryKey: jiraActivityQueryKey(jiraHost, corsProxy, weekStart, weekEnd, email),
		queryFn: ({ signal }) =>
			fetchRecentActivity({ ...config, corsProxy }, weekStart, weekEnd, signal),
		enabled: (options?.enabled ?? true) && !!jiraHost && !!apiToken,
		staleTime: 15 * 60 * 1000,
	});
}
