import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterToRealIssueKeys } from '../issueKeyValidation';
import * as jiraSearch from '../jiraSearch';

afterEach(() => vi.restoreAllMocks());

const config = {
	jiraHost: 'x.atlassian.net',
	email: 'me@x.com',
	apiToken: 't',
	corsProxy: '',
};

/**
 * Branch names carry text that *looks* like an issue key but is not one.
 * Observed on a real account: `APP-A-132/Bancontact-Integration` (a branch
 * naming convention — `APP-A-132` 404s in Jira) and `WEB-000` (a placeholder
 * used when no ticket applies).
 *
 * Widening the regex to admit the first would also admit every other
 * hyphenated branch prefix, and a hard-coded blocklist would need a new entry
 * for each convention a team invents. Asking Jira which keys are real settles
 * both cases with the one source that actually knows.
 */
describe('filterToRealIssueKeys', () => {
	function mockJiraReturning(realKeys: string[]) {
		return vi
			.spyOn(jiraSearch, 'searchAllIssues')
			.mockResolvedValue(realKeys.map((key) => ({ key })) as never);
	}

	it('keeps keys Jira recognises', async () => {
		mockJiraReturning(['PAY-222', 'BASK-30']);
		const out = await filterToRealIssueKeys(config, ['PAY-222', 'BASK-30']);
		expect([...out].sort()).toEqual(['BASK-30', 'PAY-222']);
	});

	it('drops a placeholder that does not exist', async () => {
		mockJiraReturning(['PAY-222']);
		const out = await filterToRealIssueKeys(config, ['PAY-222', 'WEB-000']);
		expect(out.has('WEB-000')).toBe(false);
	});

	it('asks Jira once for the whole batch, not once per key', async () => {
		const spy = mockJiraReturning(['PAY-1', 'PAY-2', 'PAY-3']);
		await filterToRealIssueKeys(config, ['PAY-1', 'PAY-2', 'PAY-3']);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('does not call Jira at all when there is nothing to check', async () => {
		const spy = mockJiraReturning([]);
		const out = await filterToRealIssueKeys(config, []);
		expect(spy).not.toHaveBeenCalled();
		expect(out.size).toBe(0);
	});

	it('degrades to no filtering on a Server/DC 400 rather than dropping the day', async () => {
		// Jira Server rejects the whole `issue in (...)` clause when any key is
		// unknown — which is precisely the case this function is called with.
		// Falling back to "keep everything" restores the pre-existing behaviour
		// instead of emptying the suggestion list on those deployments.
		vi.spyOn(jiraSearch, 'searchAllIssues').mockRejectedValue(
			new Error(
				"An issue with key 'WEB-000' does not exist for field 'issue'.",
			),
		);
		const out = await filterToRealIssueKeys(config, ['PAY-1', 'WEB-000']);
		expect(out.size).toBe(2);
	});

	it('keeps every key when the lookup fails, rather than losing real work', async () => {
		// Validation is a filter for noise, not a gate on correctness. If Jira is
		// unreachable, dropping everything would silently hide a day's activity —
		// far worse than showing one bogus suggestion.
		vi.spyOn(jiraSearch, 'searchAllIssues').mockRejectedValue(
			new Error('network'),
		);
		const out = await filterToRealIssueKeys(config, ['PAY-1', 'WEB-000']);
		expect([...out].sort()).toEqual(['PAY-1', 'WEB-000']);
	});
});

describe('filterToRealIssueKeys — boundaries', () => {
	it('rethrows an abort instead of resolving as if nothing was wrong', async () => {
		// Swallowing this would let a cancelled week-change resolve with a full
		// suggestion list, which the caller then has to notice was stale.
		const abort = new Error('Aborted');
		abort.name = 'AbortError';
		vi.spyOn(jiraSearch, 'searchAllIssues').mockRejectedValue(abort);
		await expect(filterToRealIssueKeys(config, ['PAY-1'])).rejects.toThrow(
			/Aborted/,
		);
	});

	it('does not call Jira when none is configured', async () => {
		const spy = vi.spyOn(jiraSearch, 'searchAllIssues');
		const out = await filterToRealIssueKeys(
			{ ...config, jiraHost: '', apiToken: '' },
			['PAY-1'],
		);
		expect(spy).not.toHaveBeenCalled();
		// Keys pass through: a GitHub-only user still gets their suggestions.
		expect(out.has('PAY-1')).toBe(true);
	});
});
