import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { jiraAuthHeader } from '../../services/jiraAuth';
import { rewriteForHostedProxy } from '../../services/jiraGateway';
import {
	getWorklogTempo,
	mapTempoWriteResponse,
	toTempoWriteInput,
} from '../../services/tempoWriteService';
import { getWorklogSource } from '../../services/worklogSource';
import { useConfigStore } from '../../stores/useConfigStore';
import type { EnrichedJiraWorklog } from '../../stores/useTimesheetStore';
import { useTimesheetStore } from '../../stores/useTimesheetStore';
import { useTempoSuspected } from './useTempoSuspected';
import {
	assertWritableRow,
	writeCreate,
	writeDelete,
	writeUpdate,
} from './worklogWriteRouter';

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
	const tempoSuspected = useTempoSuspected();
	// Writes follow reads. Scope is 'personal' because a user only ever creates,
	// edits or deletes their OWN worklogs — there is no team-scoped write.
	const writeSource = getWorklogSource({
		tempoMode: config.tempoMode,
		tempoApiToken: config.tempoApiToken,
		tempoSuspected,
		scope: 'personal',
	});
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
			Authorization: jiraAuthHeader(
				config.jiraHost,
				config.email,
				config.apiToken,
			),
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

			// Create the worklog. On a Tempo-managed instance this must go to
			// Tempo: a Jira-native POST is authored by the human, so the reads
			// (which filter on the Tempo app account) would never show it, or it
			// would double-count once Tempo imports it (ADA-544).
			const worklogUrl = buildUrl(
				`/rest/api/2/issue/${params.issueKey}/worklog`,
			);
			const newWorklog = (await writeCreate(
				writeSource,
				config,
				() =>
					makeRequest(worklogUrl, {
						method: 'POST',
						body: JSON.stringify({
							timeSpent: params.timeSpent,
							comment: params.comment,
							started: toJiraDatetime(params.started),
						}),
					}),
				toTempoWriteInput(params),
			)) as EnrichedJiraWorklog;

			// Tempo echoes a Tempo worklog, not a Jira one — it has no `id`,
			// `started` or `comment`, so storing it raw yields a dateless row that
			// never patches into the month cache and can never be matched again
			// for edit or delete. Map it into the shape the store expects.
			const mapped =
				writeSource === 'tempo'
					? mapTempoWriteResponse(
							newWorklog,
							issue,
							config.email,
							undefined,
							toTempoWriteInput(params),
						)
					: ({ ...newWorklog, issue: issue } as EnrichedJiraWorklog);

			if (!mapped) {
				// Tempo accepted the write but returned nothing we can place on a
				// day. Refetching is the honest response: inventing a row would
				// put a dateless entry into every cached month (patchMonthCaches
				// reads a null month as "all months").
				await queryClient.invalidateQueries({ queryKey: ['monthWorklogs'] });
				return null;
			}
			const enrichedWorklog: EnrichedJiraWorklog = mapped;

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

		// In auto mode the source can flip after the store was filled, leaving
		// ids from the other backend in it (ADA-544).
		assertWritableRow(
			useTimesheetStore.getState().data?.find((wl) => wl.id === worklogId),
			writeSource,
		);

		setIsLoading(true);
		setError(null);

		try {
			const worklogUrl = buildUrl(
				`/rest/api/2/issue/${issueKey}/worklog/${worklogId}`,
			);
			const updatedWorklog = (await writeUpdate(
				writeSource,
				config,
				() =>
					makeRequest(worklogUrl, {
						method: 'PUT',
						body: JSON.stringify({
							timeSpent: params.timeSpent,
							comment: params.comment,
							started: toJiraDatetime(params.started),
						}),
					}),
				worklogId,
				toTempoWriteInput({ ...params, issueKey }),
			)) as EnrichedJiraWorklog;

			// A raw Tempo echo would strip the row's id and date — and on update it
			// *destroys* an existing good row rather than merely adding a broken
			// one. Map it once here and reuse that everywhere below: the store,
			// the month-cache patch, and the moved-month calculation all need the
			// mapped shape, and previously only the store got it.
			const sentInput = toTempoWriteInput({ ...params, issueKey });
			const toStoredRow = (
				issue: EnrichedJiraWorklog['issue'],
				fallback: EnrichedJiraWorklog,
			): EnrichedJiraWorklog =>
				writeSource === 'tempo'
					? (mapTempoWriteResponse(
							updatedWorklog,
							issue,
							config.email,
							undefined,
							sentInput,
						) ?? fallback)
					: ({ ...updatedWorklog, issue } as EnrichedJiraWorklog);

			const currentData = useTimesheetStore.getState().data;
			const existingRow = currentData?.find((wl) => wl.id === worklogId);
			const updatedData = currentData?.map((wl) =>
				wl.id === worklogId ? toStoredRow(wl.issue, wl) : wl,
			);

			// Patch the month cache(s) directly rather than refetching from the
			// eventually-consistent search API, which may still return the old
			// value. The worklog can move months (started changed), so patch the
			// old month (find + replace, dropping if it moved out) and, if it now
			// belongs elsewhere, ensure it lands there too. (ADA-452)
			// Derived from the *mapped* row: a Tempo echo carries no `started`, so
			// reading it raw made this always null, and the "moved to another
			// month" cleanup below never ran — leaving a stale copy in the old
			// month and double-counting the hours across both.
			// Derived without requiring the row to be in the timesheet store: My
			// Week edits never populate that store (it is filled by the Reports
			// fetcher), so keying off it skipped the moved-month cleanup on the
			// Jira path too — leaving the old month's copy behind and
			// double-counting the hours across both.
			const placeholderIssue = { id: '', key: '', fields: {} };
			const mappedForMonth = toStoredRow(
				existingRow?.issue ?? placeholderIssue,
				{ ...updatedWorklog, issue: placeholderIssue } as EnrichedJiraWorklog,
			);
			const newMonth = mappedForMonth.started
				? worklogMonth(mappedForMonth)
				: null;
			patchMonthCaches(
				queryClient,
				(worklogs) =>
					worklogs.map((wl) =>
						wl.id === worklogId ? toStoredRow(wl.issue, wl) : wl,
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

					// Create the worklog. This must route like the single-create
					// path: clone-to-days (DayCard) uses this, and on a
					// Tempo-managed instance a Jira-native POST is authored by the
					// human — invisible to the reads, or double-counted once Tempo
					// imports it. It was previously hard-wired to Jira.
					const worklogUrl = buildUrl(
						`/rest/api/2/issue/${entry.issueKey}/worklog`,
					);
					const newWorklog = (await writeCreate(
						writeSource,
						config,
						() =>
							makeRequest(worklogUrl, {
								method: 'POST',
								body: JSON.stringify({
									timeSpent: entry.timeSpent,
									comment: entry.comment,
									started: toJiraDatetime(entry.started),
								}),
							}),
						toTempoWriteInput(entry),
					)) as EnrichedJiraWorklog;

					// Add to store
					const mappedEntry =
						writeSource === 'tempo'
							? mapTempoWriteResponse(
									newWorklog,
									issue,
									config.email,
									undefined,
									toTempoWriteInput(entry),
								)
							: ({ ...newWorklog, issue: issue } as EnrichedJiraWorklog);
					if (!mappedEntry) {
						// Created, but not placeable — count it and let the refetch
						// below pick it up rather than caching a dateless row.
						successCount++;
						continue;
					}
					const enrichedWorklog: EnrichedJiraWorklog = mappedEntry;

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
						// The mapped row, not the raw response: a Tempo echo has no
						// `id`, so the caller would get `undefined` here and could
						// never undo or edit what it just created.
						worklogId: enrichedWorklog.id ?? '',
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

		// Deleting the wrong worklog is the worst outcome here, so a stale row
		// from the other backend is refused rather than guessed at.
		assertWritableRow(
			useTimesheetStore.getState().data?.find((wl) => wl.id === worklogId),
			writeSource,
		);

		setIsLoading(true);
		setError(null);

		try {
			const worklogUrl = buildUrl(
				`/rest/api/2/issue/${issueKey}/worklog/${worklogId}`,
			);
			await writeDelete(
				writeSource,
				config,
				() => makeRequest(worklogUrl, { method: 'DELETE' }),
				issueKey,
				worklogId,
			);

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
		// Must follow the write source: this loads the current values for the
		// edit modal, and a Tempo worklog id means nothing to Jira's API. Left
		// unrouted, editing failed here — before the Tempo PUT path was ever
		// reached.
		if (writeSource === 'tempo') {
			return getWorklogTempo(config, worklogId);
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
