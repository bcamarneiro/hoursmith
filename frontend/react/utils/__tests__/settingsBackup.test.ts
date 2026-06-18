import { describe, expect, it } from 'vitest';
import {
	createSettingsBackup,
	createSettingsSharePack,
	parseSettingsBackup,
} from '../settingsBackup';

const defaultConfig = {
	jiraHost: '',
	email: '',
	apiToken: '',
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
	theme: 'system' as const,
	timeRounding: 'off' as const,
	includeAbsenceInCsv: true,
	includeCsvProvenance: false,
	analyticsOptOut: false,
};

describe('settingsBackup', () => {
	it('creates a versioned backup payload', () => {
		const backup = createSettingsBackup(defaultConfig, [
			{ issueKey: 'PROJ-1', patterns: ['Standup'] },
		]);

		expect(backup.version).toBe(3);
		expect(backup.kind).toBe('full-backup');
		expect(backup.config).toEqual(defaultConfig);
		expect(backup.calendarMappings).toEqual([
			{ issueKey: 'PROJ-1', patterns: ['Standup'] },
		]);
		expect(backup.userData).toBeUndefined();
	});

	it('round-trips userData fields when provided', () => {
		const userData = {
			favorites: [
				{
					issueKey: 'PROJ-1',
					issueSummary: 'Daily standup',
					defaultTimeSpent: '1h',
					defaultSeconds: 3600,
				},
			],
			templates: [
				{
					id: 'tpl-1',
					issueKey: 'PROJ-2',
					issueSummary: 'Standup',
					timeSpent: '15m',
					seconds: 900,
					comment: 'Daily',
					daysOfWeek: [1, 2, 3, 4, 5],
					enabled: true,
				},
			],
			commentPresets: ['Reviewed PRs', 'Pair programming'],
			dayNotes: { '2025-10-15': 'Sick day' },
			reportPresets: [
				{
					id: 'preset-1',
					label: 'My team',
					viewMode: 'weekly' as const,
					searchQuery: '',
					onlyAttentionNeeded: false,
					managerMode: true,
					trendWeeks: 6,
					sortField: 'name' as const,
					sortDirection: 'asc' as const,
					selectedUser: '',
				},
			],
		};
		const backup = createSettingsBackup(
			defaultConfig,
			[{ issueKey: 'PROJ-1', patterns: ['Standup'] }],
			userData,
		);

		expect(backup.userData).toEqual(userData);

		const parsed = parseSettingsBackup(JSON.stringify(backup), defaultConfig);
		expect(parsed.userData).toBeDefined();
		expect(parsed.userData?.favorites).toEqual(userData.favorites);
		expect(parsed.userData?.templates).toEqual(userData.templates);
		expect(parsed.userData?.commentPresets).toEqual(userData.commentPresets);
		expect(parsed.userData?.dayNotes).toEqual(userData.dayNotes);
		expect(parsed.userData?.reportPresets).toEqual(userData.reportPresets);
	});

	it('parses v2 backups (no userData) without throwing', () => {
		const v2Backup = JSON.stringify({
			version: 2,
			kind: 'full-backup',
			exportedAt: new Date().toISOString(),
			config: defaultConfig,
			calendarMappings: [],
		});
		const parsed = parseSettingsBackup(v2Backup, defaultConfig);
		expect(parsed.userData).toBeUndefined();
		expect(parsed.kind).toBe('full-backup');
	});

	it('silently drops malformed userData entries', () => {
		const raw = JSON.stringify({
			version: 3,
			kind: 'full-backup',
			exportedAt: new Date().toISOString(),
			config: defaultConfig,
			calendarMappings: [],
			userData: {
				favorites: [
					null,
					{ defaultTimeSpent: '1h' },
					{
						issueKey: 'PROJ-1',
						defaultTimeSpent: '1h',
						defaultSeconds: 3600,
					},
				],
				templates: [
					'not-an-object',
					{ id: '', issueKey: 'PROJ-2' },
					{
						id: 'tpl-1',
						issueKey: 'PROJ-2',
						timeSpent: '15m',
						seconds: 900,
						comment: '',
						daysOfWeek: [1, 2, 99, -1],
						enabled: true,
					},
				],
				commentPresets: ['  ', 42, 'Useful'],
				dayNotes: {
					'2025-10-15': 'Sick',
					'': 'ignored',
					'2025-10-16': 99,
				},
				reportPresets: [
					{},
					{
						id: 'p1',
						label: 'P1',
						viewMode: 'weird',
						searchQuery: '',
						onlyAttentionNeeded: false,
						managerMode: false,
						trendWeeks: 'bad',
						sortField: 'bad',
						sortDirection: 'bad',
						selectedUser: '',
					},
				],
			},
		});
		const parsed = parseSettingsBackup(raw, defaultConfig);
		expect(parsed.userData?.favorites).toHaveLength(1);
		expect(parsed.userData?.favorites[0].issueKey).toBe('PROJ-1');
		expect(parsed.userData?.templates).toHaveLength(1);
		expect(parsed.userData?.templates[0].daysOfWeek).toEqual([1, 2]);
		expect(parsed.userData?.commentPresets).toEqual(['Useful']);
		expect(parsed.userData?.dayNotes).toEqual({ '2025-10-15': 'Sick' });
		expect(parsed.userData?.reportPresets).toHaveLength(1);
		expect(parsed.userData?.reportPresets[0].viewMode).toBe('weekly');
		expect(parsed.userData?.reportPresets[0].sortField).toBe('name');
		expect(parsed.userData?.reportPresets[0].sortDirection).toBe('asc');
		expect(parsed.userData?.reportPresets[0].trendWeeks).toBe(4);
	});

	it('parses and normalizes imported backups', () => {
		const raw = JSON.stringify({
			version: 2,
			kind: 'full-backup',
			config: {
				jiraHost: ' jira.example.com ',
				email: ' user@example.com ',
				apiToken: ' secret ',
				calendarFeeds: [
					{
						label: ' Work ',
						url: ' https://example.com/work.ics ',
						type: 'absence',
						absenceAttribution: 'self',
						titleFilter: ' Bruno ',
					},
					{ label: 'Ignored', url: '   ' },
				],
				absenceAssignments: [
					{ pattern: ' Bruno ', userEmail: ' BRUNO@EXAMPLE.COM ' },
					{ pattern: ' ', userEmail: 'ignored@example.com' },
				],
				timeRounding: '15m',
			},
			calendarMappings: [
				{ pattern: ' Standup ', issueKey: 'proj-10' },
				{ pattern: '', issueKey: 'proj-11' },
			],
		});

		const parsed = parseSettingsBackup(raw, defaultConfig);

		expect(parsed.kind).toBe('full-backup');
		expect(parsed.config.jiraHost).toBe('jira.example.com');
		expect(parsed.config.email).toBe('user@example.com');
		expect(parsed.config.apiToken).toBe('secret');
		expect(parsed.config.timeRounding).toBe('15m');
		expect(parsed.config.calendarFeeds).toEqual([
			{
				label: 'Work',
				url: 'https://example.com/work.ics',
				type: 'absence',
				absenceAttribution: 'self',
				titleFilter: 'Bruno',
			},
		]);
		expect(parsed.config.absenceAssignments).toEqual([
			{ pattern: 'Bruno', userEmails: ['bruno@example.com'] },
		]);
		expect(parsed.calendarMappings).toEqual([
			{ issueKey: 'PROJ-10', issueSummary: undefined, patterns: ['Standup'] },
		]);
	});

	it('groups legacy single-pattern entries by issueKey on import', () => {
		const raw = JSON.stringify({
			version: 3,
			kind: 'full-backup',
			exportedAt: new Date().toISOString(),
			config: defaultConfig,
			calendarMappings: [
				{ pattern: 'Standup', issueKey: 'proj-1' },
				{ pattern: 'daily sync', issueKey: 'PROJ-1' },
				{ pattern: 'Retro', issueKey: 'proj-2' },
			],
		});

		const parsed = parseSettingsBackup(raw, defaultConfig);

		expect(parsed.calendarMappings).toEqual([
			{
				issueKey: 'PROJ-1',
				issueSummary: undefined,
				patterns: ['Standup', 'daily sync'],
			},
			{ issueKey: 'PROJ-2', issueSummary: undefined, patterns: ['Retro'] },
		]);
	});

	it('creates share packs without secrets and preserves local secrets on import', () => {
		const currentConfig = {
			...defaultConfig,
			email: 'me@example.com',
			apiToken: 'jira-token',
			corsProxy: 'http://localhost:8081',
			jiraHost: 'jira.example.com',
			jqlFilter: 'project = APP',
			allowedUsers: 'one@example.com',
			gitlabHost: 'gitlab.example.com',
			gitlabToken: 'gitlab-token',
			rescueTimeApiKey: 'rescue-token',
			theme: 'dark' as const,
			timeRounding: '30m' as const,
		};
		const sharePack = createSettingsSharePack(currentConfig, [
			{ issueKey: 'APP-1', patterns: ['Standup'] },
		]);

		expect(sharePack.kind).toBe('share-pack');
		expect(sharePack.config).toEqual({
			jiraHost: 'jira.example.com',
			jqlFilter: 'project = APP',
			allowedUsers: 'one@example.com',
			gitlabHost: 'gitlab.example.com',
			calendarFeeds: [],
			absenceAssignments: [],
		});

		const parsed = parseSettingsBackup(
			JSON.stringify(sharePack),
			currentConfig,
		);

		expect(parsed.kind).toBe('share-pack');
		expect(parsed.config.email).toBe('me@example.com');
		expect(parsed.config.apiToken).toBe('jira-token');
		expect(parsed.config.corsProxy).toBe('http://localhost:8081');
		expect(parsed.config.theme).toBe('dark');
		expect(parsed.config.jqlFilter).toBe('project = APP');
		expect(parsed.calendarMappings).toEqual([
			{ issueKey: 'APP-1', issueSummary: undefined, patterns: ['Standup'] },
		]);
	});

	it('rejects invalid files', () => {
		expect(() => parseSettingsBackup('not-json', defaultConfig)).toThrow(
			'Invalid JSON file',
		);
		expect(() => parseSettingsBackup('{}', defaultConfig)).toThrow(
			'Settings backup is missing a valid config object',
		);
	});
});
