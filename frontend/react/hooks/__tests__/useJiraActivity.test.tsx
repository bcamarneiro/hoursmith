/**
 * Tests for `useJiraActivity` (ADA-654): the recent-activity hook exposes the
 * standard TanStack Query loading/error surface and stays disabled when Jira
 * is not configured.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRecentActivity } from '../../../services/jiraActivityService';
import { useConfigStore } from '../../../stores/useConfigStore';
import type { JiraActivityItem } from '../../../types/activity';
import { jiraActivityQueryKey, useJiraActivity } from '../useJiraActivity';

vi.mock('../../../services/jiraActivityService', () => ({
	fetchRecentActivity: vi.fn(),
}));

vi.mock('../useEffectiveProxyUrl', () => ({
	useEffectiveProxyUrl: () => '',
}));

const WEEK_START = '2025-10-13';
const WEEK_END = '2025-10-19';

const mockedFetch = vi.mocked(fetchRecentActivity);

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	useConfigStore.getState().setConfig({
		...useConfigStore.getState().config,
		jiraHost: 'example.atlassian.net',
		apiToken: 'token',
		email: 'dev@example.com',
		corsProxy: '',
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('useJiraActivity', () => {
	it('exposes loading then data once the fetch resolves', async () => {
		const items: JiraActivityItem[] = [
			{
				issueKey: 'PROJ-1',
				issueSummary: 'Test issue',
				date: '2025-10-15',
				transitions: 1,
				comments: 0,
			},
		];
		let resolveFetch: (value: JiraActivityItem[]) => void = () => {};
		mockedFetch.mockReturnValue(
			new Promise((resolve) => {
				resolveFetch = resolve;
			}),
		);

		const { result } = renderHook(() => useJiraActivity(WEEK_START, WEEK_END), {
			wrapper,
		});

		expect(result.current.isLoading).toBe(true);
		expect(result.current.isError).toBe(false);
		expect(result.current.data).toBeUndefined();

		resolveFetch(items);

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.data).toEqual(items);
		expect(result.current.isError).toBe(false);
	});

	it('surfaces fetch errors through the error state', async () => {
		mockedFetch.mockRejectedValue(new Error('Jira returned 503'));

		const { result } = renderHook(() => useJiraActivity(WEEK_START, WEEK_END), {
			wrapper,
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.error).toBeInstanceOf(Error);
		expect((result.current.error as Error).message).toBe('Jira returned 503');
		expect(result.current.data).toBeUndefined();
	});

	it('stays disabled (no fetch) when Jira is not configured', async () => {
		useConfigStore.getState().setConfig({
			...useConfigStore.getState().config,
			jiraHost: '',
			apiToken: '',
		});

		const { result } = renderHook(() => useJiraActivity(WEEK_START, WEEK_END), {
			wrapper,
		});

		expect(result.current.isLoading).toBe(false);
		expect(result.current.isError).toBe(false);
		expect(mockedFetch).not.toHaveBeenCalled();
	});

	it('builds a stable, configuration-aware query key', () => {
		expect(
			jiraActivityQueryKey('example.atlassian.net', '', WEEK_START, WEEK_END, 'dev@example.com'),
		).toEqual([
			'jiraActivity',
			'example.atlassian.net',
			'',
			WEEK_START,
			WEEK_END,
			'dev@example.com',
		]);
	});
});
