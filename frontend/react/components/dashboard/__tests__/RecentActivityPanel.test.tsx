/**
 * Tests for `RecentActivityPanel` (ADA-654 UI): the panel consumes
 * `useJiraActivity` and renders per-day transition/comment rows, with distinct
 * nudge / loading / error / empty states, and reuses the shared
 * jiraActivity cache without refetching.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRecentActivity } from '../../../../services/jiraActivityService';
import { useConfigStore } from '../../../../stores/useConfigStore';
import type { JiraActivityItem } from '../../../../types/activity';
import { jiraActivityQueryKey } from '../../../hooks/useJiraActivity';
import { RecentActivityPanel } from '../RecentActivityPanel';

vi.mock('../../../../services/jiraActivityService', () => ({
	fetchRecentActivity: vi.fn(),
}));

vi.mock('../../../hooks/useEffectiveProxyUrl', () => ({
	useEffectiveProxyUrl: () => '',
}));

// CSS modules are not resolved by vitest; provide identity exports so
// class names appear in the DOM for assertion.
vi.mock('../RecentActivityPanel.module.css', () => ({
	panel: 'panel',
	title: 'title',
	header: 'header',
	summary: 'summary',
	status: 'status',
	statusError: 'statusError',
	note: 'note',
	noteLink: 'noteLink',
	list: 'list',
	dayGroup: 'dayGroup',
	dayHeader: 'dayHeader',
	dayLabel: 'dayLabel',
	dayLabelWeekend: 'dayLabelWeekend',
	dayCount: 'dayCount',
	dayList: 'dayList',
	row: 'row',
	issueKey: 'issueKey',
	issueSummary: 'issueSummary',
	badges: 'badges',
	badge: 'badge',
	badgeTransitions: 'badgeTransitions',
	badgeComments: 'badgeComments',
	num: 'num',
}));

const WEEK_START = '2025-10-13';
const WEEK_END = '2025-10-19';

const mockedFetch = vi.mocked(fetchRecentActivity);

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
	return (
		<MemoryRouter>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</MemoryRouter>
	);
}

function renderPanel() {
	return render(
		<RecentActivityPanel weekStart={WEEK_START} weekEnd={WEEK_END} />,
		{ wrapper },
	);
}

function renderPanelWithWeek(weekStart: string, weekEnd: string) {
	return render(
		<RecentActivityPanel weekStart={weekStart} weekEnd={weekEnd} />,
		{ wrapper },
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

describe('RecentActivityPanel', () => {
	it('renders a settings nudge and never fetches when Jira is not configured', () => {
		useConfigStore.getState().setConfig({
			...useConfigStore.getState().config,
			jiraHost: '',
			apiToken: '',
		});

		renderPanel();

		expect(
			screen.getByText(/Connect Jira to see your recent status transitions/),
		).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Open Settings' })).toBeTruthy();
		expect(mockedFetch).not.toHaveBeenCalled();
	});

	it('shows loading, then rows grouped by day once the fetch resolves', async () => {
		const items: JiraActivityItem[] = [
			{
				issueKey: 'PROJ-1',
				issueSummary: 'Fix the login flow',
				date: '2025-10-15',
				transitions: 1,
				comments: 2,
			},
			{
				issueKey: 'PROJ-2',
				issueSummary: 'Triage onboarding',
				date: '2025-10-15',
				transitions: 0,
				comments: 1,
			},
			{
				issueKey: 'PROJ-3',
				issueSummary: 'Polish empty states',
				date: '2025-10-13',
				transitions: 2,
				comments: 0,
			},
		];
		let resolveFetch: (value: JiraActivityItem[]) => void = () => {};
		mockedFetch.mockReturnValue(
			new Promise((resolve) => {
				resolveFetch = resolve;
			}),
		);

		renderPanel();
		expect(screen.getByText('Loading recent activity…')).toBeTruthy();

		resolveFetch(items);

		// Newest day first: Wednesday group above Monday group.
		await waitFor(() => expect(screen.getByText('Wed, Oct 15')).toBeTruthy());
		expect(screen.getByText('Mon, Oct 13')).toBeTruthy();
		expect(screen.getByText('Fix the login flow')).toBeTruthy();
		expect(screen.getByText('Triage onboarding')).toBeTruthy();
		expect(screen.getByText('Polish empty states')).toBeTruthy();

		// Activity counts render with descriptive labels.
		expect(screen.getByText('1 transition')).toBeTruthy();
		expect(screen.getByText('2 transitions')).toBeTruthy();
		expect(screen.getByText('2 comments')).toBeTruthy();
		expect(screen.getByText('1 comment')).toBeTruthy();

		// Issues with zero activity on a day get no badge.
		expect(screen.queryByText('0 transitions')).toBeNull();
		expect(screen.queryByText('0 comments')).toBeNull();

		// The count lives in its own tabular-num span, so match on full text.
		expect(
			screen.getByText((_, element) => element?.textContent === '3 issues'),
		).toBeTruthy();
	});

	it('shows an empty state when the week has no activity', async () => {
		mockedFetch.mockResolvedValue([]);

		renderPanel();

		await waitFor(() =>
			expect(screen.getByText('No Jira activity this week.')).toBeTruthy(),
		);
	});

	it('surfaces error copy and retries the fetch', async () => {
		mockedFetch.mockRejectedValueOnce(new Error('Jira returned 503'));
		const items: JiraActivityItem[] = [
			{
				issueKey: 'PROJ-9',
				issueSummary: 'Retry target',
				date: '2025-10-14',
				transitions: 1,
				comments: 0,
			},
		];
		mockedFetch.mockResolvedValueOnce(items);

		renderPanel();

		await waitFor(() =>
			expect(screen.getByText('Jira returned 503')).toBeTruthy(),
		);

		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

		await waitFor(() => expect(screen.getByText('Retry target')).toBeTruthy());
		expect(mockedFetch).toHaveBeenCalledTimes(2);
	});

	it('reuses the shared jiraActivity cache without refetching', async () => {
		const items: JiraActivityItem[] = [
			{
				issueKey: 'PROJ-1',
				issueSummary: 'Cached issue',
				date: '2025-10-15',
				transitions: 1,
				comments: 0,
			},
		];
		mockedFetch.mockResolvedValue(items);

		// Simulate the dashboard fetcher warming the shared cache.
		await queryClient.fetchQuery({
			queryKey: jiraActivityQueryKey(
				'example.atlassian.net',
				'',
				WEEK_START,
				WEEK_END,
			),
			queryFn: () =>
				fetchRecentActivity(
					useConfigStore.getState().config,
					WEEK_START,
					WEEK_END,
				),
			staleTime: 15 * 60 * 1000,
		});

		renderPanel();

		await waitFor(() => expect(screen.getByText('Cached issue')).toBeTruthy());
		// The panel must reuse the cached activity items, not fetch again.
		expect(mockedFetch).toHaveBeenCalledTimes(1);
	});

	it('applies weekend styling to days that fall on Saturday or Sunday', async () => {
		const items: JiraActivityItem[] = [
			{
				issueKey: 'PROJ-1',
				issueSummary: 'Weekday work',
				date: '2025-10-15', // Wednesday
				transitions: 1,
				comments: 0,
			},
			{
				issueKey: 'PROJ-2',
				issueSummary: 'Weekend work',
				date: '2025-10-19', // Sunday
				transitions: 0,
				comments: 1,
			},
		];
		mockedFetch.mockResolvedValue(items);

		renderPanel();

		await waitFor(() => {
			expect(screen.getByText('Wed, Oct 15')).toBeTruthy();
		});
		expect(screen.getByText('Sun, Oct 19')).toBeTruthy();

		const sunLabel = screen.getByText('Sun, Oct 19');
		expect(sunLabel.classList.contains('dayLabelWeekend')).toBe(true);

		const wedLabel = screen.getByText('Wed, Oct 15');
		expect(wedLabel.classList.contains('dayLabelWeekend')).toBe(false);
	});

	it('uses singular "1 issue" when only one distinct issue appears', async () => {
		const items: JiraActivityItem[] = [
			{
				issueKey: 'PROJ-1',
				issueSummary: 'First change',
				date: '2025-10-15',
				transitions: 1,
				comments: 0,
			},
			{
				issueKey: 'PROJ-1',
				issueSummary: 'Second change same issue',
				date: '2025-10-16',
				transitions: 0,
				comments: 2,
			},
		];
		mockedFetch.mockResolvedValue(items);

		renderPanel();

		await waitFor(() => {
			expect(screen.getByText('First change')).toBeTruthy();
		});

		// Header should read "1 issue" (singular), not "1 issues" or "2 issues".
		expect(
			screen.getByText(
				(_content, element) => element?.textContent === '1 issue',
			),
		).toBeTruthy();
		expect(
			screen.queryByText(
				(_content, element) => element?.textContent === '1 issues',
			),
		).toBeNull();
	});

	it('refetches when the week changes', async () => {
		const items: JiraActivityItem[] = [
			{
				issueKey: 'PROJ-1',
				issueSummary: 'Week A item',
				date: '2025-10-15',
				transitions: 1,
				comments: 0,
			},
		];
		mockedFetch.mockResolvedValue(items);

		const { rerender } = renderPanelWithWeek('2025-10-13', '2025-10-19');

		await waitFor(() => {
			expect(screen.getByText('Week A item')).toBeTruthy();
		});
		expect(mockedFetch).toHaveBeenCalledTimes(1);

		// Re-render with the following week — the query key changes so
		// useJiraActivity must issue a fresh fetch.
		rerender(
			<RecentActivityPanel weekStart="2025-10-20" weekEnd="2025-10-26" />,
		);

		await waitFor(() => {
			expect(mockedFetch).toHaveBeenCalledTimes(2);
		});
	});
});
