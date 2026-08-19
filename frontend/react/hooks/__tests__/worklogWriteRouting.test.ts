import { describe, expect, it, vi } from 'vitest';
import * as tempoWrite from '../../../services/tempoWriteService';
import { writeCreate, writeDelete } from '../worklogWriteRouter';

const config = {
	jiraHost: 'x.atlassian.net',
	email: 'me@x.com',
	apiToken: 't',
	corsProxy: '',
	tempoApiToken: 'tempo-tok',
} as never;

/**
 * The whole point of the write router: on a Tempo-managed instance, reads come
 * from Tempo, so writes must too. A worklog POSTed to Jira there is authored by
 * the human rather than the Tempo app account, so it either never appears in
 * the reads or double-counts once Tempo imports it.
 */
describe('worklog write routing', () => {
	it('creates through Tempo when the source is tempo', async () => {
		const spy = vi
			.spyOn(tempoWrite, 'createWorklogTempo')
			.mockResolvedValue({});
		const jiraCreate = vi.fn();
		await writeCreate('tempo', config, jiraCreate, {
			issueKey: 'PAY-1',
			timeSpentSeconds: 3600,
			startDate: '2026-07-27',
			startTime: '09:00:00',
			description: 'work',
		});
		expect(spy).toHaveBeenCalled();
		expect(jiraCreate).not.toHaveBeenCalled();
	});

	it('creates through Jira when the source is jira', async () => {
		const spy = vi
			.spyOn(tempoWrite, 'createWorklogTempo')
			.mockResolvedValue({});
		const jiraCreate = vi.fn().mockResolvedValue({});
		await writeCreate('jira', config, jiraCreate, {
			issueKey: 'PAY-1',
			timeSpentSeconds: 3600,
			startDate: '2026-07-27',
			startTime: '09:00:00',
			description: 'work',
		});
		expect(jiraCreate).toHaveBeenCalled();
		expect(spy).not.toHaveBeenCalled();
	});

	it('deletes through Tempo when the source is tempo', async () => {
		const spy = vi.spyOn(tempoWrite, 'deleteWorklogTempo').mockResolvedValue();
		const jiraDelete = vi.fn();
		await writeDelete('tempo', config, jiraDelete, 'PAY-1', '491168');
		expect(spy).toHaveBeenCalledWith(config, '491168', undefined);
		expect(jiraDelete).not.toHaveBeenCalled();
	});

	it('deletes through Jira when the source is jira', async () => {
		const spy = vi.spyOn(tempoWrite, 'deleteWorklogTempo').mockResolvedValue();
		const jiraDelete = vi.fn().mockResolvedValue(undefined);
		await writeDelete('jira', config, jiraDelete, 'PAY-1', '491168');
		expect(jiraDelete).toHaveBeenCalledWith('PAY-1', '491168');
		expect(spy).not.toHaveBeenCalled();
	});
});
