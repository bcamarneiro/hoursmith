/**
 * Tests for the recent-activity service (ADA-654).
 *
 * `fetchRecentActivity` is the robust fetch + normalization layer: it guards
 * against an unconfigured Jira connection, skips malformed changelog entries
 * instead of throwing, and produces the normalized `JiraActivityItem`
 * contract. `fetchJiraActivitySuggestions` builds worklog suggestions on top
 * of that contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../stores/useConfigStore';
import type {
	JiraChangelogHistory,
	JiraIssueWithChangelog,
} from '../../types/activity';
import {
	fetchJiraActivitySuggestions,
	fetchRecentActivity,
	JIRA_KEY_RE,
} from '../jiraActivityService';
import { fetchSearchPage } from '../jiraSearch';

vi.mock('../jiraSearch', () => ({
	fetchSearchPage: vi.fn(),
}));

const WEEK_START = '2025-10-13';
const WEEK_END = '2025-10-19';

const baseConfig: Config = {
	jiraHost: 'example.atlassian.net',
	email: 'dev@example.com',
	apiToken: 'token',
	corsProxy: '',
	jqlFilter: '',
	allowedUsers: '',
	canAddWorklogs: true,
	canEditWorklogs: true,
	canDeleteWorklogs: true,
	gitlabToken: '',
	gitlabHost: '',
	rescueTimeApiKey: '',
	calendarFeeds: [],
	absenceAssignments: [],
	complianceReminderEnabled: false,
	theme: 'system',
	timeRounding: 'off',
	includeAbsenceInCsv: true,
	includeCsvProvenance: false,
};

const mockedFetchSearchPage = vi.mocked(fetchSearchPage);

function history(
	created: string,
	authorEmail: string,
	items: { field: string; fromString?: string; toString?: string }[],
) {
	return { created, author: { emailAddress: authorEmail }, items };
}

function issue(
	partial: Partial<JiraIssueWithChangelog>,
): JiraIssueWithChangelog {
	return { key: 'PROJ-1', fields: { summary: 'Test issue' }, ...partial };
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('fetchRecentActivity', () => {
	it('returns [] without calling Jira when not configured', async () => {
		const result = await fetchRecentActivity(
			{ ...baseConfig, jiraHost: '' },
			WEEK_START,
			WEEK_END,
		);
		expect(result).toEqual([]);
		expect(mockedFetchSearchPage).not.toHaveBeenCalled();
	});

	it('fetches with the week-scoped JQL and changelog expansion', async () => {
		mockedFetchSearchPage.mockResolvedValue({ issues: [] });
		await fetchRecentActivity(baseConfig, WEEK_START, WEEK_END);
		expect(mockedFetchSearchPage).toHaveBeenCalledWith(
			baseConfig,
			{
				jql: `(assignee = currentUser() OR worklogAuthor = currentUser()) AND updated >= "${WEEK_START}" AND updated <= "${WEEK_END}"`,
				fields: 'summary',
				maxResults: 20,
				expand: 'changelog',
			},
			undefined,
		);
	});

	it('normalizes changelog histories into per-day activity items', async () => {
		mockedFetchSearchPage.mockResolvedValue({
			issues: [
				issue({
					changelog: {
						histories: [
							history('2025-10-15T09:00:00.000+0000', 'dev@example.com', [
								{
									field: 'status',
									fromString: 'To Do',
									toString: 'In Progress',
								},
							]),
							history('2025-10-15T14:00:00.000+0000', 'dev@example.com', [
								{ field: 'comment', toString: 'Looking into this' },
							]),
							history('2025-10-16T10:00:00.000+0000', 'dev@example.com', [
								{
									field: 'status',
									fromString: 'In Progress',
									toString: 'Done',
								},
							]),
						],
					},
				}),
			],
		});

		const result = await fetchRecentActivity(baseConfig, WEEK_START, WEEK_END);
		expect(result).toEqual([
			{
				issueKey: 'PROJ-1',
				issueSummary: 'Test issue',
				date: '2025-10-15',
				transitions: 1,
				comments: 1,
			},
			{
				issueKey: 'PROJ-1',
				issueSummary: 'Test issue',
				date: '2025-10-16',
				transitions: 1,
				comments: 0,
			},
		]);
	});

	it('skips histories from other authors and outside the week', async () => {
		mockedFetchSearchPage.mockResolvedValue({
			issues: [
				issue({
					changelog: {
						histories: [
							history(
								'2025-10-15T09:00:00.000+0000',
								'someone.else@example.com',
								[{ field: 'status', toString: 'In Progress' }],
							),
							history('2025-09-01T09:00:00.000+0000', 'dev@example.com', [
								{ field: 'status', toString: 'In Progress' },
							]),
							history('2025-10-16T09:00:00.000+0000', 'dev@example.com', [
								{ field: 'status', toString: 'Done' },
							]),
						],
					},
				}),
			],
		});

		const result = await fetchRecentActivity(baseConfig, WEEK_START, WEEK_END);
		expect(result).toEqual([
			{
				issueKey: 'PROJ-1',
				issueSummary: 'Test issue',
				date: '2025-10-16',
				transitions: 1,
				comments: 0,
			},
		]);
	});

	it('skips malformed histories instead of throwing', async () => {
		const malformedHistories: JiraChangelogHistory[] = [
			// Missing `created` — malformed on purpose
			{
				author: { emailAddress: 'dev@example.com' },
				items: [{ field: 'status' }],
			} as unknown as JiraChangelogHistory,
			// Empty `items` (not missing — items is [] but the guard still works)
			history('2025-10-15T09:00:00.000+0000', 'dev@example.com', []),
			// Non-array `items`
			{
				created: '2025-10-15T10:00:00.000+0000',
				author: { emailAddress: 'dev@example.com' },
				// biome-ignore lint/suspicious/noExplicitAny: malformed fixture
				items: 'not-an-array' as any,
			},
			// Valid history — must still be processed
			history('2025-10-15T11:00:00.000+0000', 'dev@example.com', [
				{ field: 'comment', toString: 'Valid' },
			]),
		];
		mockedFetchSearchPage.mockResolvedValue({
			issues: [
				issue({
					changelog: {
						histories: malformedHistories,
					},
				}),
			],
		});

		const result = await fetchRecentActivity(baseConfig, WEEK_START, WEEK_END);
		expect(result).toEqual([
			{
				issueKey: 'PROJ-1',
				issueSummary: 'Test issue',
				date: '2025-10-15',
				transitions: 0,
				comments: 1,
			},
		]);
	});

	it('tolerates issues without changelog and empty histories', async () => {
		mockedFetchSearchPage.mockResolvedValue({
			issues: [issue({}), issue({ changelog: { histories: [] } })],
		});
		const result = await fetchRecentActivity(baseConfig, WEEK_START, WEEK_END);
		expect(result).toEqual([]);
	});

	it('compares author emails case-insensitively', async () => {
		mockedFetchSearchPage.mockResolvedValue({
			issues: [
				issue({
					changelog: {
						histories: [
							history('2025-10-15T09:00:00.000+0000', 'DEV@EXAMPLE.COM', [
								{ field: 'status', toString: 'In Progress' },
							]),
						],
					},
				}),
			],
		});
		const result = await fetchRecentActivity(
			{ ...baseConfig, email: 'Dev@Example.com' },
			WEEK_START,
			WEEK_END,
		);
		expect(result).toHaveLength(1);
		expect(result[0].transitions).toBe(1);
	});
});

describe('fetchJiraActivitySuggestions', () => {
	it('builds suggestions from normalized activity with the estimation rules', async () => {
		mockedFetchSearchPage.mockResolvedValue({
			issues: [
				issue({
					changelog: {
						histories: [
							history('2025-10-15T09:00:00.000+0000', 'dev@example.com', [
								{
									field: 'status',
									fromString: 'To Do',
									toString: 'In Progress',
								},
								{
									field: 'status',
									fromString: 'In Progress',
									toString: 'Done',
								},
							]),
							history('2025-10-15T14:00:00.000+0000', 'dev@example.com', [
								{ field: 'comment', toString: 'Nice work' },
							]),
						],
					},
				}),
			],
		});

		const suggestions = await fetchJiraActivitySuggestions(
			baseConfig,
			WEEK_START,
			WEEK_END,
		);
		expect(suggestions).toEqual([
			{
				id: 'jira-PROJ-1-2025-10-15',
				source: 'jira-activity',
				issueKey: 'PROJ-1',
				issueSummary: 'Test issue',
				date: '2025-10-15',
				suggestedTimeSpent: '2h 30m',
				suggestedSeconds: 9000,
				confidence: 'medium',
				reason: '2 status changes, 1 comment',
				logged: false,
			},
		]);
	});

	it('floors suggestions at 30m and marks comment-only days as low confidence', async () => {
		mockedFetchSearchPage.mockResolvedValue({
			issues: [
				issue({
					changelog: {
						histories: [
							history('2025-10-15T09:00:00.000+0000', 'dev@example.com', [
								{ field: 'comment', toString: 'Just a note' },
							]),
						],
					},
				}),
			],
		});

		const suggestions = await fetchJiraActivitySuggestions(
			baseConfig,
			WEEK_START,
			WEEK_END,
		);
		expect(suggestions).toEqual([
			{
				id: 'jira-PROJ-1-2025-10-15',
				source: 'jira-activity',
				issueKey: 'PROJ-1',
				issueSummary: 'Test issue',
				date: '2025-10-15',
				suggestedTimeSpent: '30m',
				suggestedSeconds: 1800,
				confidence: 'low',
				reason: '1 comment',
				logged: false,
			},
		]);
	});
});

describe('JIRA_KEY_RE', () => {
	it('matches a Jira key prefix', () => {
		expect('PROJ-123 extra'.match(JIRA_KEY_RE)?.[0]).toBe('PROJ-123');
	});
});
