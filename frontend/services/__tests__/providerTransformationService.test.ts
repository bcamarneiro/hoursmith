import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RescueTimeDaySummary, WorklogSuggestion } from '../../../types/Suggestion';
import {
	fetchProviderTransformations,
	type ProviderError,
	type ProviderTransformationResult,
} from '../providerTransformationService';

// --------------- helpers ---------------

function makeSuggestion(
	overrides: Partial<WorklogSuggestion> = {},
): WorklogSuggestion {
	return {
		id: 's-1',
		source: 'jira-activity',
		issueKey: 'TEST-1',
		date: '2026-07-20',
		suggestedTimeSpent: '1h',
		suggestedSeconds: 3600,
		confidence: 'medium',
		reason: 'test',
		logged: false,
		...overrides,
	};
}

function rescueTimeDay(productiveSeconds: number): RescueTimeDaySummary {
	return { productiveSeconds, topActivities: [] };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
	return {
		jiraHost: 'jira.example.com',
		email: 'dev@example.com',
		apiToken: 'jira-token',
		corsProxy: 'https://proxy.example.com',
		gitlabToken: '',
		gitlabHost: '',
		rescueTimeApiKey: '',
		calendarFeeds: [],
		timeRounding: { enabled: false, step: 15 },
		...overrides,
	};
}

// --------------- mocks ---------------

const fetchJira = vi.fn();
const fetchGitlab = vi.fn();
const fetchCalendar = vi.fn();
const fetchRescue = vi.fn();

vi.mock('../jiraActivityService', () => ({
	fetchJiraActivitySuggestions: (...args: unknown[]) => fetchJira(...args),
}));

vi.mock('../gitlabService', () => ({
	fetchGitlabSuggestions: (...args: unknown[]) => fetchGitlab(...args),
}));

vi.mock('../calendarService', () => ({
	fetchCalendarSuggestions: (...args: unknown[]) => fetchCalendar(...args),
}));

vi.mock('../rescueTimeService', () => ({
	fetchRescueTimeData: (...args: unknown[]) => fetchRescue(...args),
}));

// --------------- tests ---------------

describe('fetchProviderTransformations', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// -- happy path -------------------------------------------------------

	it('returns empty arrays for unconfigured providers', async () => {
		// Jira is always called (it returns [] early when unconfigured).
		// GitLab / RescueTime / Calendar are skipped entirely when missing
		// credentials, so they stay empty without being called.
		fetchJira.mockResolvedValue([]);

		const config = makeConfig({
			jiraHost: '',
			apiToken: '',
			gitlabToken: '',
			gitlabHost: '',
			rescueTimeApiKey: '',
		});
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(result.jiraSuggestions).toEqual([]);
		expect(fetchJira).toHaveBeenCalledOnce();
		expect(result.gitlabSuggestions).toEqual([]);
		expect(result.calendarSuggestions).toEqual([]);
		expect(result.rescueTimeData.size).toBe(0);
		expect(result.errors).toHaveLength(0);
	});

	it('calls configured providers and collects results', async () => {
		const jiraSuggestion = makeSuggestion({ source: 'jira-activity' });
		fetchJira.mockResolvedValue([jiraSuggestion]);

		const config = makeConfig();
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(fetchJira).toHaveBeenCalledOnce();
		expect(result.jiraSuggestions).toEqual([jiraSuggestion]);
		expect(result.errors).toHaveLength(0);
	});

	it('calls gitlab when configured', async () => {
		const glSuggestion = makeSuggestion({ source: 'gitlab', issueKey: 'GL-1' });
		fetchJira.mockResolvedValue([]);
		fetchGitlab.mockResolvedValue([glSuggestion]);

		const config = makeConfig({
			gitlabToken: 'gl-token',
			gitlabHost: 'gitlab.example.com',
		});
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(fetchGitlab).toHaveBeenCalledOnce();
		expect(result.gitlabSuggestions).toEqual([glSuggestion]);
		expect(result.errors).toHaveLength(0);
	});

	it('calls calendar when suggestion feeds are configured', async () => {
		const calSuggestion = makeSuggestion({ source: 'calendar' });
		fetchJira.mockResolvedValue([]);
		fetchCalendar.mockResolvedValue([calSuggestion]);

		const config = makeConfig({
			calendarFeeds: [
				{ type: 'suggestion', url: 'https://cal.example.com/feed.ics', label: 'Work' },
			],
		});
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(fetchCalendar).toHaveBeenCalledOnce();
		expect(result.calendarSuggestions).toEqual([calSuggestion]);
	});

	it('does NOT call calendar for non-suggestion feeds (absence/holiday)', async () => {
		fetchJira.mockResolvedValue([]);

		const config = makeConfig({
			calendarFeeds: [
				{ type: 'absence', url: 'https://cal.example.com/absences.ics', label: 'Absences' },
				{ type: 'holiday', url: 'https://cal.example.com/holidays.ics', label: 'Holidays' },
			],
		});
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(fetchCalendar).not.toHaveBeenCalled();
		expect(result.calendarSuggestions).toEqual([]);
	});

	it('calls rescuetime when API key is configured', async () => {
		const rtMap = new Map([['2026-07-20', rescueTimeDay(7200)]]);
		fetchJira.mockResolvedValue([]);
		fetchRescue.mockResolvedValue(rtMap);

		const config = makeConfig({ rescueTimeApiKey: 'rt-key' });
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(fetchRescue).toHaveBeenCalledOnce();
		expect(result.rescueTimeData).toBe(rtMap);
	});

	it('calls all configured providers in parallel', async () => {
		fetchJira.mockResolvedValue([]);
		fetchGitlab.mockResolvedValue([]);
		fetchCalendar.mockResolvedValue([]);
		fetchRescue.mockResolvedValue(new Map());

		const config = makeConfig({
			gitlabToken: 'gl-token',
			gitlabHost: 'gitlab.example.com',
			rescueTimeApiKey: 'rt-key',
			calendarFeeds: [
				{ type: 'suggestion', url: 'https://cal.example.com/feed.ics', label: 'Work' },
			],
		});
		await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(fetchJira).toHaveBeenCalledOnce();
		expect(fetchGitlab).toHaveBeenCalledOnce();
		expect(fetchCalendar).toHaveBeenCalledOnce();
		expect(fetchRescue).toHaveBeenCalledOnce();
	});

	// -- error handling ---------------------------------------------------

	it('captures jira failure and returns empty suggestions', async () => {
		fetchJira.mockRejectedValue(new Error('Jira API error: 401'));

		const config = makeConfig();
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(result.jiraSuggestions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject<ProviderError>({
			source: 'jira',
			message: 'Jira API error: 401',
		});
	});

	it('captures gitlab failure and returns empty suggestions', async () => {
		fetchJira.mockResolvedValue([]);
		fetchGitlab.mockRejectedValue(new Error('403 Forbidden'));

		const config = makeConfig({
			gitlabToken: 'gl-token',
			gitlabHost: 'gitlab.example.com',
		});
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(result.gitlabSuggestions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject<ProviderError>({
			source: 'gitlab',
			message: '403 Forbidden',
		});
	});

	it('captures calendar failure and returns empty suggestions', async () => {
		fetchJira.mockResolvedValue([]);
		fetchCalendar.mockRejectedValue(new Error('Network error'));

		const config = makeConfig({
			calendarFeeds: [
				{ type: 'suggestion', url: 'https://cal.example.com/feed.ics', label: 'Work' },
			],
		});
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(result.calendarSuggestions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject<ProviderError>({
			source: 'calendar',
			message: 'Network error',
		});
	});

	it('captures rescuetime failure and returns empty map', async () => {
		fetchJira.mockResolvedValue([]);
		fetchRescue.mockRejectedValue(new Error('Invalid API key'));

		const config = makeConfig({ rescueTimeApiKey: 'bad-key' });
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(result.rescueTimeData.size).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject<ProviderError>({
			source: 'rescuetime',
			message: 'Invalid API key',
		});
	});

	it('captures multiple failures from different providers', async () => {
		fetchJira.mockRejectedValue(new Error('Jira down'));
		fetchGitlab.mockRejectedValue(new Error('GitLab timeout'));
		fetchCalendar.mockRejectedValue(new Error('Calendar unreachable'));
		fetchRescue.mockRejectedValue(new Error('RescueTime 500'));

		const config = makeConfig({
			gitlabToken: 'gl-token',
			gitlabHost: 'gitlab.example.com',
			rescueTimeApiKey: 'rt-key',
			calendarFeeds: [
				{ type: 'suggestion', url: 'https://cal.example.com/feed.ics', label: 'Work' },
			],
		});
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(result.errors).toHaveLength(4);
		expect(result.errors.map((e) => e.source).sort()).toEqual([
			'calendar',
			'gitlab',
			'jira',
			'rescuetime',
		]);
		expect(result.jiraSuggestions).toEqual([]);
		expect(result.gitlabSuggestions).toEqual([]);
		expect(result.calendarSuggestions).toEqual([]);
		expect(result.rescueTimeData.size).toBe(0);
	});

	it('coerces non-Error rejections to strings', async () => {
		fetchJira.mockRejectedValue('plain string error');

		const config = makeConfig();
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].message).toBe('plain string error');
	});

	// -- passthrough ------------------------------------------------------

	it('passes weekStart and weekEnd to provider services', async () => {
		fetchJira.mockResolvedValue([]);

		const config = makeConfig();
		await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(fetchJira).toHaveBeenCalledWith(
			config,
			'2026-07-20',
			'2026-07-26',
			undefined,
		);
	});

	it('passes the abort signal through to providers', async () => {
		fetchJira.mockResolvedValue([]);
		const controller = new AbortController();

		const config = makeConfig();
		await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
			signal: controller.signal,
		});

		expect(fetchJira).toHaveBeenCalledWith(
			config,
			'2026-07-20',
			'2026-07-26',
			controller.signal,
		);
	});

	it('passes calendarMappings through to fetchCalendarSuggestions', async () => {
		fetchJira.mockResolvedValue([]);
		fetchCalendar.mockResolvedValue([]);

		const mappings = [
			{ issueKey: 'PROJ-1', patterns: ['standup'] },
		];
		const config = makeConfig({
			calendarFeeds: [
				{ type: 'suggestion', url: 'https://cal.example.com/feed.ics', label: 'Work' },
			],
		});
		await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
			calendarMappings: mappings,
		});

		expect(fetchCalendar).toHaveBeenCalledWith(
			[{ type: 'suggestion', url: 'https://cal.example.com/feed.ics', label: 'Work' }],
			config.corsProxy,
			'2026-07-20',
			'2026-07-26',
			mappings,
			undefined,
		);
	});

	// -- partial failure --------------------------------------------------

	it('returns successful results alongside errors', async () => {
		const jiraSuggestion = makeSuggestion();
		fetchJira.mockResolvedValue([jiraSuggestion]);
		fetchGitlab.mockRejectedValue(new Error('GitLab down'));

		const config = makeConfig({
			gitlabToken: 'gl-token',
			gitlabHost: 'gitlab.example.com',
		});
		const result = await fetchProviderTransformations({
			config,
			weekStart: '2026-07-20',
			weekEnd: '2026-07-26',
		});

		expect(result.jiraSuggestions).toEqual([jiraSuggestion]);
		expect(result.gitlabSuggestions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].source).toBe('gitlab');
	});
});
