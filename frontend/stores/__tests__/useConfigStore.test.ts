import { describe, expect, it } from 'vitest';
import {
	CONFIG_STORAGE_VERSION,
	createDefaultConfig,
	migratePersistedConfigState,
	normalizeConfig,
} from '../useConfigStore';

describe('useConfigStore helpers', () => {
	it('normalizes host-like fields and CSV lists', () => {
		const config = normalizeConfig({
			jiraHost: ' https://jira.example.com/ ',
			email: ' user@example.com ',
			apiToken: ' token ',
			corsProxy: ' http://localhost:8081/ ',
			allowedUsers: ' one@example.com,  two@example.com ,, ',
			gitlabHost: ' https://gitlab.example.com/ ',
			calendarFeeds: [
				{
					label: ' Team absences ',
					url: ' https://calendar.example.com/ooo.ics ',
					type: 'absence',
					absenceAttribution: 'self',
					titleFilter: ' Bruno ',
				},
			],
			absenceAssignments: [
				{ pattern: ' Bruno ', userEmails: [' BRUNO@EXAMPLE.COM '] },
			],
		});

		expect(config.jiraHost).toBe('jira.example.com');
		expect(config.email).toBe('user@example.com');
		expect(config.apiToken).toBe('token');
		expect(config.corsProxy).toBe('http://localhost:8081');
		expect(config.allowedUsers).toBe('one@example.com, two@example.com');
		expect(config.gitlabHost).toBe('gitlab.example.com');
		expect(config.calendarFeeds).toEqual([
			{
				label: 'Team absences',
				url: 'https://calendar.example.com/ooo.ics',
				type: 'absence',
				absenceAttribution: 'self',
				titleFilter: 'Bruno',
			},
		]);
		expect(config.absenceAssignments).toEqual([
			{ pattern: 'Bruno', userEmails: ['bruno@example.com'] },
		]);
	});

	it('defaults analyticsOptOut to false and preserves an explicit opt-out (ADA-472)', () => {
		expect(createDefaultConfig().analyticsOptOut).toBe(false);
		// Missing on disk → fills the default.
		expect(normalizeConfig({}).analyticsOptOut).toBe(false);
		// Non-boolean garbage → falls back to default.
		expect(
			normalizeConfig({ analyticsOptOut: 'yes' as unknown as boolean })
				.analyticsOptOut,
		).toBe(false);
		// Explicit true is preserved.
		expect(normalizeConfig({ analyticsOptOut: true }).analyticsOptOut).toBe(
			true,
		);
	});

	it('migrates old persisted config into the current normalized shape', () => {
		const migrated = migratePersistedConfigState(
			{
				config: {
					jiraHost: ' https://jira.example.com/ ',
					calendarFeeds: [
						{ label: 'Work', url: ' https://calendar.test/feed ' },
					],
				},
			},
			0,
		);

		expect(migrated.config?.jiraHost).toBe('jira.example.com');
		expect(migrated.config?.calendarFeeds).toEqual([
			{
				label: 'Work',
				url: 'https://calendar.test/feed',
				type: 'suggestion',
			},
		]);
	});

	it('infers shared attribution for migrated absence feeds when assignments exist', () => {
		const migrated = normalizeConfig({
			calendarFeeds: [
				{
					label: 'Team vacations',
					url: 'https://calendar.test/vacations.ics',
					type: 'absence',
				},
			],
			absenceAssignments: [
				{ pattern: 'Bruno', userEmails: ['bruno@example.com'] },
			],
		});

		expect(migrated.calendarFeeds).toEqual([
			{
				label: 'Team vacations',
				url: 'https://calendar.test/vacations.ics',
				type: 'absence',
				absenceAttribution: 'shared',
			},
		]);
	});

	it('keeps the default schema complete when normalizing sparse input', () => {
		const config = normalizeConfig(
			{
				jiraHost: 'jira.example.com',
			},
			createDefaultConfig(),
		);

		expect(config).toMatchObject({
			jiraHost: 'jira.example.com',
			theme: 'system',
			timeRounding: 'off',
			includeAbsenceInCsv: true,
			canAddWorklogs: true,
		});
		expect(CONFIG_STORAGE_VERSION).toBeGreaterThan(0);
	});
});

describe('migration scaffold — future schema bump rehearsal', () => {
	/**
	 * These tests don't migrate a real schema change — there isn't one
	 * pending. They rehearse the scaffold so we know it survives a future
	 * `CONFIG_STORAGE_VERSION` bump without rewriting the store. If you ever
	 * add a new persisted field (e.g. backdateCommentPatterns), update or
	 * mirror these tests with the v(N) → v(N+1) migration path.
	 */
	it('tolerates a "future" version higher than the current one', () => {
		const futureVersion = CONFIG_STORAGE_VERSION + 1;
		const migrated = migratePersistedConfigState(
			{
				config: {
					jiraHost: 'future.example.com',
					email: 'future@example.com',
					apiToken: 'tok',
					theme: 'dark',
					timeRounding: '15m',
					// Imaginary field a v(N+1) schema might introduce:
					backdateCommentPatterns: ['Foo: %DATE%'],
				} as never,
			},
			futureVersion,
		);
		// The current normaliser must NOT throw, must return a usable Config,
		// and must keep canonical fields. Unknown fields are silently dropped.
		expect(migrated.config?.jiraHost).toBe('future.example.com');
		expect(migrated.config?.theme).toBe('dark');
		expect(migrated.config?.timeRounding).toBe('15m');
		// `normalizeConfig` spreads input so unknown fields ride along — this is
		// the forward-compat property: a newer tab can write a v(N+1) field,
		// an older tab will preserve it on subsequent saves rather than drop
		// it. The downside (no strict schema enforcement) is documented here
		// so a future migration explicitly knows what the contract is.
		expect(
			(migrated.config as unknown as { backdateCommentPatterns?: unknown })
				.backdateCommentPatterns,
		).toEqual(['Foo: %DATE%']);
	});

	it('legacy v(0) blob still migrates to current shape', () => {
		const migrated = migratePersistedConfigState(
			{
				config: {
					jiraHost: 'old.example.com',
					email: 'old@example.com',
				},
			},
			0,
		);
		expect(migrated.config?.jiraHost).toBe('old.example.com');
		expect(migrated.config?.theme).toBe('system');
		expect(migrated.config?.calendarFeeds).toEqual([]);
	});

	it('null/undefined persistedState returns a default-shaped config', () => {
		expect(migratePersistedConfigState(undefined, 0).config?.theme).toBe(
			'system',
		);
		expect(migratePersistedConfigState(null, 0).config?.theme).toBe('system');
	});
});

describe('github config fields', () => {
	it('defaults github fields to empty strings', () => {
		const c = createDefaultConfig();
		expect(c.githubToken).toBe('');
		expect(c.githubHost).toBe('');
	});

	it('trims githubToken and normalizes githubHost', () => {
		const c = normalizeConfig({
			githubToken: '  tok  ',
			githubHost: 'https://github.example.com/',
		});
		expect(c.githubToken).toBe('tok');
		expect(c.githubHost).toBe('github.example.com');
	});
});
