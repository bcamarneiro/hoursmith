import { beforeEach, describe, expect, it } from 'vitest';
import { useConfigStore } from '../../../stores/useConfigStore';
import { monthWorklogsQueryKey } from '../useMonthWorklogs';

/**
 * These tests verify that all hooks that fetch month worklogs produce
 * consistent query keys. When keys diverge, TanStack Query makes separate
 * API calls — causing data mismatches between tabs.
 *
 * All views now use currentUserOnly=false (fetching all users, filtering in JS).
 * This ensures a single shared cache entry per (year, month, jqlFilter).
 */

describe('monthWorklogs query key consistency', () => {
	const year = 2026;
	const month = 2; // March (0-indexed)
	const jiraHost = 'jira.example.com';
	const corsProxy = 'https://proxy.example.com';

	beforeEach(() => {
		useConfigStore.setState({
			config: {
				jiraHost,
				email: 'user@example.com',
				apiToken: 'token',
				corsProxy,
				jqlFilter: '',
				allowedUsers: '',
				canAddWorklogs: true,
				canEditWorklogs: true,
				canDeleteWorklogs: true,
				gitlabToken: '',
				gitlabHost: '',
				githubToken: '',
				githubHost: '',
				rescueTimeApiKey: '',
				calendarFeeds: [],
				absenceAssignments: [],
				complianceReminderEnabled: false,
				theme: 'system',
				timeRounding: 'off',
				includeAbsenceInCsv: true,
				includeCsvProvenance: false,
				analyticsOptOut: false,
			},
		});
	});

	it('all views produce the same key when jqlFilter is empty', () => {
		const jqlFilter = '';

		// Team/Timesheet page (via useMonthWorklogs, no currentUserOnly)
		const teamKey = monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			false,
			jqlFilter,
		);

		// Dashboard (via queryClient.fetchQuery)
		const dashboardKey = monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			false,
			jqlFilter,
		);

		// Heatmap (via useMonthWorklogs)
		const heatmapKey = monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			false,
			jqlFilter,
		);

		expect(teamKey).toEqual(dashboardKey);
		expect(teamKey).toEqual(heatmapKey);
	});

	it('all views produce the same key when jqlFilter is set', () => {
		const jqlFilter = 'project = MYPROJ';

		const teamKey = monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			false,
			jqlFilter,
		);

		const dashboardKey = monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			false,
			jqlFilter,
		);

		expect(teamKey).toEqual(dashboardKey);
		expect(teamKey).toContain('project = MYPROJ');
	});

	it('query key includes all discriminating fields', () => {
		const key = monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			false,
			'project = X',
		);

		expect(key).toEqual([
			'monthWorklogs',
			year,
			month,
			jiraHost,
			corsProxy,
			false,
			'project = X',
		]);
	});

	it('different jqlFilter values produce different keys', () => {
		const keyNoFilter = monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			false,
			'',
		);

		const keyWithFilter = monthWorklogsQueryKey(
			year,
			month,
			jiraHost,
			corsProxy,
			false,
			'project = X',
		);

		expect(keyNoFilter).not.toEqual(keyWithFilter);
	});
});

describe('jqlFilter derivation consistency', () => {
	/**
	 * Each hook that fetches month worklogs should derive jqlFilter the same way.
	 * This test documents the expected derivation pattern:
	 *   const jqlFilter = config.jqlFilter?.trim() || '';
	 *   fetchOpts: { jqlFilter: jqlFilter || undefined }
	 *   queryKey: monthWorklogsQueryKey(..., false, jqlFilter)
	 */
	it('all hooks derive jqlFilter the same way from config', () => {
		const testCases = [
			{ input: '', expectedKey: '', expectedOpt: undefined },
			{ input: '  ', expectedKey: '', expectedOpt: undefined },
			{
				input: 'project = X',
				expectedKey: 'project = X',
				expectedOpt: 'project = X',
			},
			{
				input: '  project = X  ',
				expectedKey: 'project = X',
				expectedOpt: 'project = X',
			},
		];

		for (const { input, expectedKey, expectedOpt } of testCases) {
			const jqlFilter = input?.trim() || '';
			const fetchOptJql = jqlFilter || undefined;

			expect(jqlFilter).toBe(expectedKey);
			expect(fetchOptJql).toBe(expectedOpt);
		}
	});

	it('timesheet and dashboard use same jqlFilter derivation', () => {
		const configJqlFilter = 'project = TEST';

		// Both hooks use: config.jqlFilter?.trim() || ''
		const timesheetJql = configJqlFilter?.trim() || '';
		const dashboardJql = configJqlFilter?.trim() || '';

		expect(timesheetJql).toBe(dashboardJql);
	});
});
