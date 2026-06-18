/**
 * ADA-452: created / edited / deleted worklogs must appear immediately and
 * survive a subsequent (possibly stale) refetch from Jira's eventually
 * consistent `/search/jql`. These tests verify that the mutation patches the
 * `monthWorklogs` React Query cache directly rather than invalidating it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfigStore } from '../../../stores/useConfigStore';
import type { EnrichedJiraWorklog } from '../../../stores/useTimesheetStore';
import { useTimesheetStore } from '../../../stores/useTimesheetStore';
import { monthWorklogsQueryKey } from '../useMonthWorklogs';
import { useWorklogOperations } from '../useWorklogOperations';

const JIRA_HOST = 'example.atlassian.net';
const CORS_PROXY = '';

function makeWorklog(
	id: string,
	started: string,
	issueKey = 'PROJ-1',
): EnrichedJiraWorklog {
	return {
		id,
		self: '',
		started,
		created: started,
		timeSpent: '1h',
		timeSpentSeconds: 3600,
		comment: '',
		author: { emailAddress: 'dev@example.com' },
		issue: { id: '1', key: issueKey, fields: { summary: 'Test' } },
	} as EnrichedJiraWorklog;
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

// October 2025 (month index 9) cache key, matching how the hooks build it.
const OCT_KEY = monthWorklogsQueryKey(
	2025,
	9,
	JIRA_HOST,
	CORS_PROXY,
	false,
	'',
);

beforeEach(() => {
	queryClient = new QueryClient();
	useConfigStore.getState().setConfig({
		...useConfigStore.getState().config,
		jiraHost: JIRA_HOST,
		apiToken: 'token',
		email: 'dev@example.com',
		corsProxy: CORS_PROXY,
	});
	useTimesheetStore.getState().setData(null);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('useWorklogOperations cache patching (ADA-452)', () => {
	it('createWorklog patches the matching month cache immediately', async () => {
		queryClient.setQueryData<EnrichedJiraWorklog[]>(OCT_KEY, [
			makeWorklog('existing', '2025-10-10T09:00:00.000+0000'),
		]);

		vi.spyOn(global, 'fetch')
			// issue existence check
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					id: '1',
					key: 'PROJ-1',
					fields: { summary: 'Test' },
				}),
			} as Response)
			// worklog POST
			.mockResolvedValueOnce({
				ok: true,
				status: 201,
				json: async () => ({
					id: 'new',
					started: '2025-10-15T09:00:00.000+0000',
					timeSpentSeconds: 3600,
				}),
			} as Response);

		const { result } = renderHook(() => useWorklogOperations(), { wrapper });

		await act(async () => {
			await result.current.createWorklog({
				issueKey: 'PROJ-1',
				timeSpent: '1h',
				comment: '',
				started: '2025-10-15T09:00:00.000+0000',
			});
		});

		const cache = queryClient.getQueryData<EnrichedJiraWorklog[]>(OCT_KEY);
		expect(cache?.map((w) => w.id)).toEqual(['existing', 'new']);
	});

	it('createWorklog does NOT add to a non-matching month cache', async () => {
		const novKey = monthWorklogsQueryKey(
			2025,
			10,
			JIRA_HOST,
			CORS_PROXY,
			false,
			'',
		);
		queryClient.setQueryData<EnrichedJiraWorklog[]>(novKey, []);

		vi.spyOn(global, 'fetch')
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: '1', key: 'PROJ-1', fields: {} }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 201,
				json: async () => ({
					id: 'new',
					started: '2025-10-15T09:00:00.000+0000',
					timeSpentSeconds: 3600,
				}),
			} as Response);

		const { result } = renderHook(() => useWorklogOperations(), { wrapper });
		await act(async () => {
			await result.current.createWorklog({
				issueKey: 'PROJ-1',
				timeSpent: '1h',
				comment: '',
				started: '2025-10-15T09:00:00.000+0000',
			});
		});

		// October worklog must not leak into the November cache.
		expect(queryClient.getQueryData<EnrichedJiraWorklog[]>(novKey)).toEqual([]);
	});

	it('deleteWorklog removes the worklog from the month cache immediately', async () => {
		queryClient.setQueryData<EnrichedJiraWorklog[]>(OCT_KEY, [
			makeWorklog('keep', '2025-10-10T09:00:00.000+0000'),
			makeWorklog('drop', '2025-10-11T09:00:00.000+0000'),
		]);

		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 204,
		} as Response);

		const { result } = renderHook(() => useWorklogOperations(), { wrapper });
		await act(async () => {
			await result.current.deleteWorklog('PROJ-1', 'drop');
		});

		const cache = queryClient.getQueryData<EnrichedJiraWorklog[]>(OCT_KEY);
		expect(cache?.map((w) => w.id)).toEqual(['keep']);
	});

	it('updateWorklog patches the cached worklog in place, preserving the issue', async () => {
		queryClient.setQueryData<EnrichedJiraWorklog[]>(OCT_KEY, [
			makeWorklog('edit', '2025-10-10T09:00:00.000+0000'),
		]);

		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				id: 'edit',
				started: '2025-10-10T09:00:00.000+0000',
				timeSpentSeconds: 7200,
				timeSpent: '2h',
			}),
		} as Response);

		const { result } = renderHook(() => useWorklogOperations(), { wrapper });
		await act(async () => {
			await result.current.updateWorklog('PROJ-1', 'edit', {
				timeSpent: '2h',
				comment: '',
				started: '2025-10-10T09:00:00.000+0000',
			});
		});

		const cache = queryClient.getQueryData<EnrichedJiraWorklog[]>(OCT_KEY);
		expect(cache).toHaveLength(1);
		expect(cache?.[0]?.timeSpentSeconds).toBe(7200);
		// Issue enrichment is preserved from the previous cache entry.
		expect(cache?.[0]?.issue.key).toBe('PROJ-1');
	});
});
