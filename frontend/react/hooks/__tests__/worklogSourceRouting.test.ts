import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as jira from '../../../services/monthWorklogService';
import * as tempo from '../../../services/tempoWorklogService';
import { getWorklogSource } from '../../../services/worklogSource';
import type { Config } from '../../../stores/useConfigStore';
import { createDefaultConfig } from '../../../stores/useConfigStore';

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
	...createDefaultConfig(),
	jiraHost: 'h',
	email: 'e',
	apiToken: 'a',
	...overrides,
});

describe('month read routing', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('calls Tempo when source resolves to tempo', async () => {
		const tempoSpy = vi
			.spyOn(tempo, 'fetchMonthWorklogsTempo')
			.mockResolvedValue([]);
		const jiraSpy = vi.spyOn(jira, 'fetchMonthWorklogs').mockResolvedValue([]);
		const source = getWorklogSource({
			tempoMode: 'tempo',
			tempoApiToken: 't',
			tempoSuspected: false,
			scope: 'personal' as const,
		});
		const { readMonth } = await import('../worklogReadRouter');
		await readMonth(source, makeConfig({ tempoApiToken: 't' }), 2026, 5);
		expect(tempoSpy).toHaveBeenCalled();
		expect(jiraSpy).not.toHaveBeenCalled();
	});

	it('calls Jira when source resolves to jira', async () => {
		const tempoSpy = vi
			.spyOn(tempo, 'fetchMonthWorklogsTempo')
			.mockResolvedValue([]);
		const jiraSpy = vi.spyOn(jira, 'fetchMonthWorklogs').mockResolvedValue([]);
		const source = getWorklogSource({
			tempoMode: 'jira',
			tempoApiToken: '',
			tempoSuspected: false,
			scope: 'personal' as const,
		});
		const { readMonth } = await import('../worklogReadRouter');
		await readMonth(source, makeConfig(), 2026, 5);
		expect(jiraSpy).toHaveBeenCalled();
		expect(tempoSpy).not.toHaveBeenCalled();
	});
});

describe('team-scoped reads now reach Tempo (ADA-545)', () => {
	it('resolves team scope to tempo once the non-user-scoped read exists', () => {
		expect(
			getWorklogSource({
				tempoMode: 'tempo',
				tempoApiToken: 'tok',
				tempoSuspected: true,
				scope: 'team',
			}),
		).toBe('tempo');
	});

	it('routes a team-scoped month read to the team fetcher, not the per-user one', async () => {
		const teamSpy = vi
			.spyOn(tempo, 'fetchTeamMonthWorklogsTempo')
			.mockResolvedValue([]);
		const perUserSpy = vi
			.spyOn(tempo, 'fetchMonthWorklogsTempo')
			.mockResolvedValue([]);
		const { readMonth } = await import('../worklogReadRouter');
		await readMonth('tempo', makeConfig({ tempoApiToken: 't' }), 2026, 6, {
			scope: 'team',
		});
		expect(teamSpy).toHaveBeenCalled();
		expect(perUserSpy).not.toHaveBeenCalled();
	});

	it('still routes a personal-scoped month read to the per-user fetcher', async () => {
		const teamSpy = vi
			.spyOn(tempo, 'fetchTeamMonthWorklogsTempo')
			.mockResolvedValue([]);
		const perUserSpy = vi
			.spyOn(tempo, 'fetchMonthWorklogsTempo')
			.mockResolvedValue([]);
		const { readMonth } = await import('../worklogReadRouter');
		await readMonth('tempo', makeConfig({ tempoApiToken: 't' }), 2026, 6, {
			scope: 'personal',
		});
		expect(perUserSpy).toHaveBeenCalled();
		expect(teamSpy).not.toHaveBeenCalled();
	});
});
