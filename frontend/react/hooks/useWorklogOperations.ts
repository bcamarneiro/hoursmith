import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { rewriteForHostedProxy } from '../../services/jiraGateway';
import { useConfigStore } from '../../stores/useConfigStore';
import type { EnrichedJiraWorklog } from '../../stores/useTimesheetStore';
import { useTimesheetStore } from '../../stores/useTimesheetStore';

/**
 * Which month a worklog belongs to, in the same 0-indexed shape used by the
 * `monthWorklogs` query key. Derived from `started`, falling back to `created`.
 * Returns null when neither is parseable so the patch is skipped rather than
 * mis-bucketed.
 */
function worklogMonth(
	wl: EnrichedJiraWorklog,
): { year: number; month: number } | null {
	const raw = wl.started || wl.created;
	if (!raw) return null;
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) return null;
	return { year: d.getFullYear(), month: d.getMonth() };
}

/**
 * ADA-452: Jira's `/search/jql` is eventually consistent, so a refetch right
 * after a mutation can return stale data (missing a just-created worklog, or
 * still showing a just-deleted one). Instead of invalidating the month query
 * (which would refetch from that lagging endpoint), patch every cached
 * `monthWorklogs` entry directly so the change shows immediately and survives a
 * later stale refetch. Only caches whose month matches the worklog are touched.
 */
function patchMonthCaches(
	queryClient: QueryClient,
	updater: (worklogs: EnrichedJiraWorklog[]) => EnrichedJiraWorklog[],
	targetMonth: { year: number; month: number } | null,
) {
	// Read existing entries so we can inspect each query key, then patch the
	// matching months by exact key (the v5 `setQueriesData` updater receives
	// only the data, not the key).
	const entries = queryClient.getQueriesData<EnrichedJiraWorklog[]>({
		queryKey: ['monthWorklogs'],
	});
	for (const [key, prev] of entries) {
		if (!prev) continue;
		// Query key shape: ['monthWorklogs', year, month, ...]
		const year = key[1] as number;
		const month = key[2] as number;
		if (
			targetMonth &&
			(year !== targetMonth.year || month !== targetMonth.month)
		) {
			continue;
		}
		queryClient.setQueryData<EnrichedJiraWorklog[]>(key, updater(prev));
	}
}

/** Format a date string to Jira's expected format: 2026-03-02T09:00:00.000+0000 */
function toJiraDatetime(dateStr: string): string {
	const d = new Date(dateStr);
	const offset = -d.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const absOffset = Math.abs(offset);
	const hh = String(Math.floor(absOffset / 60)).padStart(2, '0');
	const mm = String(absOffset % 60).padStart(2, '0');

	const pad = (n: number, len = 2) => String(n).padStart(len, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${hh}${mm}`;
}

export function useWorklogOperations() {
	const config = useConfigStore((state) => state.config);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const setData = useTimesheetStore((state) => state.setData);
	const queryClient = useQueryClient();

	// Helper to build the full URL
	const buildUrl = (path: string): string => {
		const baseUrl = config.corsProxy
			? `${config.corsProxy.replace(/\/$/, '')}/https://${config.jiraHost}`
			: `https://${config.jiraHost}`;
		return `${baseUrl}${path}`;
	};

	// Helper to make authenticated requests
	const makeRequest = async (url: string, options: RequestInit = {}) => {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${config.apiToken}`,
			Accept: 'application/json',
			'Content-Type': 'application/json',
			'X-Atlassian-Token': 'no-check',
			...(options.headers as Record<string, string> | undefined),
		};

		// Route through the hosted Premium proxy when entitled (ADA-273).
		const rewritten = rewriteForHostedProxy(url, headers, {
			jiraHost: config.jiraHost,
			email: config.email,
			apiToken: config.apiToken,
		});

		const response = await fetch(rewritten.url, {
			...options,
			headers: rewritten.headers,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Jira API error: ${response.status} - ${text}`);
		}

		// 204 No Content (e.g. DELETE) returns no body
		if (response.status === 204) return null;
		return response.json();
	};

	const createWorklog = async (params: {
		issueKey: string;
		timeSpent: string;
		comment: string;
		started: string;
	}) => {
		if (!config.jiraHost || !config.apiToken) {
			throw new Error('Jira client not configured');
		}

		setIsLoading(true);
		setError(null);

		try {
			// First, validate that the issue exists
			const issueUrl = buildUrl(
				`/rest/api/2/issue/${params.issueKey}?fields=summary,issuetype,parent,project,status`,
			);
			const issue = await makeRequest(issueUrl);

			if (!issue) {
				throw new Error(`Issue ${params.issueKey} not found`);
			}

			// Create the worklog
			const worklogUrl = buildUrl(
				`/rest/api/2/issue/${params.issueKey}/worklog`,
			);
			const newWorklog = await makeRequest(worklogUrl, {
				method: 'POST',
				body: JSON.stringify({
					timeSpent: params.timeSpent,
					comment: params.comment,
					started: toJiraDatetime(params.started),
				}),
			});

			// Add the new worklog to the store with issue info
			const enrichedWorklog: EnrichedJiraWorklog = {
				...newWorklog,
				issue: issue,
			};

			const currentData = useTimesheetStore.getState().data;
			// Patch the month cache(s) instead of invalidating: the search API is
			// eventually consistent, so an immediate refetch can omit this new
			// worklog. (ADA-452)
			patchMonthCaches(
				queryClient,
				(worklogs) => [...worklogs, enrichedWorklog],
				worklogMonth(enrichedWorklog),
			);
			setData([...(currentData || []), enrichedWorklog]);

			return enrichedWorklog;
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : 'Failed to create worklog';
			setError(errorMessage);
			throw new Error(errorMessage);
		} finally {
			setIsLoading(false);
		}
	};

	const updateWorklog = async (
		issueKey: string,
		worklogId: string,
		params: {
			timeSpent: string;
			comment: string;
			started: string;
		},
	) => {
		if (!config.jiraHost || !config.apiToken) {
			throw new Error('Jira client not configured');
		}

		setIsLoading(true);
		setError(null);

		try {
			const worklogUrl = buildUrl(
				`/rest/api/2/issue/${issueKey}/worklog/${worklogId}`,
			);
			const updatedWorklog = await makeRequest(worklogUrl, {
				method: 'PUT',
				body: JSON.stringify({
					timeSpent: params.timeSpent,
					comment: params.comment,
					started: toJiraDatetime(params.started),
				}),
			});

			// Update in the store
			const currentData = useTimesheetStore.getState().data;
			const updatedData = currentData?.map((wl) => {
				if (wl.id === worklogId) {
					return {
						...updatedWorklog,
						issue: wl.issue,
					};
				}
				return wl;
			});

			// Patch the month cache(s) directly rather than refetching from the
			// eventually-consistent search API, which may still return the old
			// value. The worklog can move months (started changed), so patch the
			// old month (find + replace, dropping if it moved out) and, if it now
			// belongs elsewhere, ensure it lands there too. (ADA-452)
			const newMonth = updatedWorklog?.started
				? worklogMonth({
						...updatedWorklog,
						issue: { id: '', key: '', fields: {} },
					} as EnrichedJiraWorklog)
				: null;
			patchMonthCaches(
				queryClient,
				(worklogs) =>
					worklogs.map((wl) =>
						wl.id === worklogId ? { ...updatedWorklog, issue: wl.issue } : wl,
					),
				null,
			);
			// Drop stale copies from months the worklog no longer belongs to.
			if (newMonth) {
				patchMonthCaches(
					queryClient,
					(worklogs) => {
						const existing = worklogs.find((wl) => wl.id === worklogId);
						if (!existing) return worklogs;
						const wlMonth = worklogMonth(existing);
						if (
							wlMonth &&
							(wlMonth.year !== newMonth.year ||
								wlMonth.month !== newMonth.month)
						) {
							return worklogs.filter((wl) => wl.id !== worklogId);
						}
						return worklogs;
					},
					null,
				);
			}
			setData(updatedData || null);

			return updatedWorklog;
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : 'Failed to update worklog';
			setError(errorMessage);
			throw new Error(errorMessage);
		} finally {
			setIsLoading(false);
		}
	};

	const createMultipleWorklogs = async (
		params: Array<{
			issueKey: string;
			timeSpent: string;
			comment: string;
			started: string;
		}>,
	): Promise<{
		success: number;
		failed: string[];
		created: Array<{ issueKey: string; worklogId: string }>;
	}> => {
		if (!config.jiraHost || !config.apiToken) {
			throw new Error('Jira client not configured');
		}

		setIsLoading(true);
		setError(null);

		const failed: string[] = [];
		const created: Array<{ issueKey: string; worklogId: string }> = [];
		let successCount = 0;

		try {
			for (const entry of params) {
				try {
					// Validate that the issue exists
					const issueUrl = buildUrl(
						`/rest/api/2/issue/${entry.issueKey}?fields=summary,issuetype,parent,project,status`,
					);
					const issue = await makeRequest(issueUrl);

					if (!issue) {
						failed.push(entry.issueKey);
						continue;
					}

					// Create the worklog
					const worklogUrl = buildUrl(
						`/rest/api/2/issue/${entry.issueKey}/worklog`,
					);
					const newWorklog = await makeRequest(worklogUrl, {
						method: 'POST',
						body: JSON.stringify({
							timeSpent: entry.timeSpent,
							comment: entry.comment,
							started: toJiraDatetime(entry.started),
						}),
					});

					// Add to store
					const enrichedWorklog: EnrichedJiraWorklog = {
						...newWorklog,
						issue: issue,
					};

					const updatedData = [
						...(useTimesheetStore.getState().data || []),
						enrichedWorklog,
					];
					patchMonthCaches(
						queryClient,
						(worklogs) => [...worklogs, enrichedWorklog],
						worklogMonth(enrichedWorklog),
					);
					setData(updatedData);

					created.push({
						issueKey: entry.issueKey,
						worklogId: newWorklog.id,
					});
					successCount++;
				} catch {
					failed.push(entry.issueKey);
				}
			}

			return { success: successCount, failed, created };
		} finally {
			setIsLoading(false);
		}
	};

	const deleteWorklog = async (issueKey: string, worklogId: string) => {
		if (!config.jiraHost || !config.apiToken) {
			throw new Error('Jira client not configured');
		}

		setIsLoading(true);
		setError(null);

		try {
			const worklogUrl = buildUrl(
				`/rest/api/2/issue/${issueKey}/worklog/${worklogId}`,
			);
			await makeRequest(worklogUrl, {
				method: 'DELETE',
			});

			// Remove from the store
			const currentData = useTimesheetStore.getState().data;
			const updatedData = currentData?.filter((wl) => wl.id !== worklogId);
			// Remove from the month cache(s) directly. A refetch from the
			// eventually-consistent search API could still return the deleted
			// worklog, so we patch rather than invalidate. (ADA-452)
			patchMonthCaches(
				queryClient,
				(worklogs) => worklogs.filter((wl) => wl.id !== worklogId),
				null,
			);
			setData(updatedData || null);
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : 'Failed to delete worklog';
			setError(errorMessage);
			throw new Error(errorMessage);
		} finally {
			setIsLoading(false);
		}
	};

	/**
	 * Fetch a single worklog's current fields so an edit can preserve `comment`
	 * and `started` — `updateWorklog` PUTs all three, so editing only the time
	 * without these would wipe the comment and reset the date.
	 */
	const getWorklog = async (
		issueKey: string,
		worklogId: string,
	): Promise<{ timeSpent: string; comment: string; started: string }> => {
		if (!config.jiraHost || !config.apiToken) {
			throw new Error('Jira client not configured');
		}
		const worklogUrl = buildUrl(
			`/rest/api/2/issue/${issueKey}/worklog/${worklogId}`,
		);
		const wl = await makeRequest(worklogUrl, { method: 'GET' });
		return {
			timeSpent: typeof wl?.timeSpent === 'string' ? wl.timeSpent : '',
			comment: typeof wl?.comment === 'string' ? wl.comment : '',
			started: typeof wl?.started === 'string' ? wl.started : '',
		};
	};

	return {
		createWorklog,
		createMultipleWorklogs,
		updateWorklog,
		deleteWorklog,
		getWorklog,
		isLoading,
		error,
	};
}
