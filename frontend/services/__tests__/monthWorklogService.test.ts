import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../stores/useConfigStore';
import { fetchMonthWorklogs } from '../monthWorklogService';
import { ServiceError } from '../serviceErrors';

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

describe('fetchMonthWorklogs', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('uses embedded worklogs when the search response is complete', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				total: 1,
				issues: [
					{
						id: '10000',
						key: 'PROJ-1',
						fields: {
							summary: 'Issue summary',
							worklog: {
								startAt: 0,
								maxResults: 20,
								total: 1,
								worklogs: [
									{
										id: 'w1',
										started: '2025-10-15T09:00:00.000+0000',
										timeSpentSeconds: 3600,
										author: {
											displayName: 'Alex',
											emailAddress: 'alex@example.com',
										},
									},
								],
							},
						},
					},
				],
			}),
		} as Response);

		const result = await fetchMonthWorklogs(baseConfig, 2025, 9);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result).toHaveLength(1);
		expect(result[0]?.issue.key).toBe('PROJ-1');
	});

	it('includes Pattern B (jira-native) backdated embedded worklogs in the target month', async () => {
		// started in September, created in October — classifier should bucket
		// this on the created date (Pattern B). The service-level filter must
		// therefore include it when scanning October.
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				total: 1,
				issues: [
					{
						id: '10000',
						key: 'PROJ-1',
						fields: {
							summary: 'Issue summary',
							worklog: {
								startAt: 0,
								maxResults: 20,
								total: 1,
								worklogs: [
									{
										id: 'wB',
										started: '2025-09-28T09:00:00.000+0000',
										created: '2025-10-02T09:00:00.000+0000',
										timeSpentSeconds: 3600,
										author: {
											displayName: 'Alex',
											emailAddress: 'alex@example.com',
										},
									},
								],
							},
						},
					},
				],
			}),
		} as Response);

		const result = await fetchMonthWorklogs(baseConfig, 2025, 9);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('wB');
	});

	it('fetches full issue worklogs when embedded worklogs are truncated', async () => {
		const fetchMock = vi
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					total: 1,
					issues: [
						{
							id: '10000',
							key: 'PROJ-1',
							fields: {
								summary: 'Issue summary',
								worklog: {
									startAt: 0,
									maxResults: 20,
									total: 30,
									worklogs: [],
								},
							},
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					worklogs: [
						{
							id: 'w2',
							started: '2025-10-20T09:00:00.000+0000',
							timeSpentSeconds: 7200,
							author: {
								displayName: 'Alex',
								emailAddress: 'alex@example.com',
							},
						},
					],
				}),
			} as Response);

		const result = await fetchMonthWorklogs(baseConfig, 2025, 9);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[0]).toContain('/issue/PROJ-1/worklog');
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('w2');
	});

	it('throws a ServiceError when the search response is not ok', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 401,
			json: async () => ({}),
		} as Response);

		await expect(fetchMonthWorklogs(baseConfig, 2025, 9)).rejects.toMatchObject(
			{
				name: 'ServiceError',
				kind: 'unauthorized',
				status: 401,
				source: 'Jira search',
			},
		);

		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 500,
			json: async () => ({}),
		} as Response);
		await expect(
			fetchMonthWorklogs(baseConfig, 2025, 9),
		).rejects.toBeInstanceOf(ServiceError);
	});

	it('emits progress updates for search and truncated worklog fetches', async () => {
		const onProgress = vi.fn();
		vi.spyOn(global, 'fetch')
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					total: 1,
					issues: [
						{
							id: '10000',
							key: 'PROJ-1',
							fields: {
								summary: 'Issue summary',
								worklog: {
									startAt: 0,
									maxResults: 20,
									total: 30,
									worklogs: [],
								},
							},
						},
					],
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					worklogs: [],
				}),
			} as Response);

		await fetchMonthWorklogs(baseConfig, 2025, 9, { onProgress });

		expect(onProgress).toHaveBeenCalled();
		expect(onProgress.mock.calls[0]?.[0]).toMatchObject({
			phase: 'searching',
			percent: 8,
		});
		expect(
			onProgress.mock.calls.some((call) => call[0]?.phase === 'inspecting'),
		).toBe(true);
		expect(
			onProgress.mock.calls.some(
				(call) => call[0]?.phase === 'fetching-truncated',
			),
		).toBe(true);
		expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({
			phase: 'complete',
			percent: 100,
		});
	});
});
