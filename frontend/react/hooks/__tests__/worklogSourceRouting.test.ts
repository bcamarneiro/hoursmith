import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../stores/useConfigStore';
import { createDefaultConfig } from '../../../stores/useConfigStore';
import { getWorklogSource } from '../../../services/worklogSource';
import * as tempo from '../../../services/tempoWorklogService';
import * as jira from '../../../services/monthWorklogService';

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
		});
		const { readMonth } = await import('../worklogReadRouter');
		await readMonth(source, makeConfig(), 2026, 5);
		expect(jiraSpy).toHaveBeenCalled();
		expect(tempoSpy).not.toHaveBeenCalled();
	});
});
