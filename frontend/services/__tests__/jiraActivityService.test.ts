import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../stores/useConfigStore';
import { fetchJiraActivitySuggestions } from '../jiraActivityService';
import * as jiraSearch from '../jiraSearch';

afterEach(() => vi.restoreAllMocks());

const config = {
	jiraHost: 'x.atlassian.net',
	email: 'me@x.com',
	apiToken: 't',
	corsProxy: '',
} as Config;

function history(created: string, fields: string[]) {
	return {
		created,
		author: { emailAddress: 'me@x.com' },
		items: fields.map((field) => ({ field })),
	};
}

function mockIssues(issues: unknown[]) {
	return vi
		.spyOn(jiraSearch, 'searchAllIssues')
		.mockResolvedValue(issues as never);
}

/**
 * Compared against Tempo's own calendar for the same week, this produced far
 * fewer rows: Tempo listed eight tickets for a day where we offered one. Two
 * causes, both here.
 */
describe('fetchJiraActivitySuggestions — activity it was ignoring', () => {
	it('counts an edit that is not a transition or a comment', async () => {
		// Reassigning, re-pointing, editing a description or attaching a file is
		// work on that ticket that day. Only `status` and `comment` were counted,
		// so a day spent editing tickets produced nothing at all.
		mockIssues([
			{
				key: 'PAY-53',
				fields: { summary: 'Apple Pay' },
				changelog: {
					histories: [history('2026-08-05T10:00:00.000+0000', ['assignee'])],
				},
			},
		]);
		const out = await fetchJiraActivitySuggestions(
			config,
			'2026-08-03',
			'2026-08-09',
		);
		expect(out.map((s) => s.issueKey)).toContain('PAY-53');
	});

	it('says why an edit-only day was suggested, instead of a blank reason', async () => {
		// These days reach the 30m floor via a code path that counts nothing, so
		// the reason rendered as an empty line: a suggestion with no stated
		// justification is one the user cannot judge.
		mockIssues([
			{
				key: 'PAY-53',
				fields: { summary: 'Apple Pay' },
				changelog: {
					histories: [
						history('2026-08-05T10:00:00.000+0000', ['assignee', 'labels']),
					],
				},
			},
		]);
		const out = await fetchJiraActivitySuggestions(
			config,
			'2026-08-03',
			'2026-08-09',
		);
		expect(out[0]?.reason).toMatch(/edit/i);
	});

	it('still rates a transition above a bare field edit', async () => {
		mockIssues([
			{
				key: 'PAY-1',
				fields: { summary: 'a' },
				changelog: {
					histories: [history('2026-08-05T10:00:00.000+0000', ['status'])],
				},
			},
			{
				key: 'PAY-2',
				fields: { summary: 'b' },
				changelog: {
					histories: [history('2026-08-05T10:00:00.000+0000', ['labels'])],
				},
			},
		]);
		const out = await fetchJiraActivitySuggestions(
			config,
			'2026-08-03',
			'2026-08-09',
		);
		const transition = out.find((s) => s.issueKey === 'PAY-1');
		const edit = out.find((s) => s.issueKey === 'PAY-2');
		expect(transition?.suggestedSeconds).toBeGreaterThan(
			edit?.suggestedSeconds ?? 0,
		);
	});

	it('ignores a field change made by someone else', async () => {
		mockIssues([
			{
				key: 'PAY-3',
				fields: { summary: 'c' },
				changelog: {
					histories: [
						{
							created: '2026-08-05T10:00:00.000+0000',
							author: { emailAddress: 'someone@else.com' },
							items: [{ field: 'assignee' }],
						},
					],
				},
			},
		]);
		const out = await fetchJiraActivitySuggestions(
			config,
			'2026-08-03',
			'2026-08-09',
		);
		expect(out).toHaveLength(0);
	});

	it('pages through the week instead of taking one capped page', async () => {
		// A busy week touches far more than one page of tickets, and the widened
		// query above is what makes that likely. Raising the cap alone would
		// only move the truncation point.
		const spy = mockIssues([]);
		await fetchJiraActivitySuggestions(config, '2026-08-03', '2026-08-09');
		expect(spy).toHaveBeenCalled();
		const params = spy.mock.calls[0]?.[1] as { maxResults: number };
		expect(params.maxResults).toBeGreaterThan(20);
	});
});

describe('fetchJiraActivitySuggestions — reach of the query', () => {
	it('finds issues you changed but are not assigned to', async () => {
		// Verified against a live instance: for one week the assignee/worklog
		// query returned a single issue while `status CHANGED BY currentUser()`
		// returned four — the three extra were colleagues' tickets this user had
		// moved. Tempo listed all four; we listed one.
		const spy = mockIssues([]);
		await fetchJiraActivitySuggestions(config, '2026-08-03', '2026-08-09');
		const { jql } = spy.mock.calls[0]?.[1] as { jql: string };
		expect(jql).toContain('CHANGED BY currentUser()');
	});

	it('keeps the assignee and worklog-author reach as well', async () => {
		const spy = mockIssues([]);
		await fetchJiraActivitySuggestions(config, '2026-08-03', '2026-08-09');
		const { jql } = spy.mock.calls[0]?.[1] as { jql: string };
		expect(jql).toContain('assignee = currentUser()');
		expect(jql).toContain('worklogAuthor = currentUser()');
	});

	it('includes the whole of the last day, not up to its midnight', async () => {
		// Verified against a live instance: DURING ("2026-08-05","2026-08-05")
		// returns nothing while ("2026-08-05","2026-08-05 23:59") returns two
		// issues. A bare end date means 00:00, so every week silently lost its
		// final day — and weekEnd is inclusive everywhere else in this file.
		const spy = mockIssues([]);
		await fetchJiraActivitySuggestions(config, '2026-08-03', '2026-08-09');
		const { jql } = spy.mock.calls[0]?.[1] as { jql: string };
		expect(jql).toContain('"2026-08-09 23:59"');
	});

	it('orders by recency so a truncated page keeps the newest work', async () => {
		const spy = mockIssues([]);
		await fetchJiraActivitySuggestions(config, '2026-08-03', '2026-08-09');
		const { jql } = spy.mock.calls[0]?.[1] as { jql: string };
		expect(jql).toContain('ORDER BY updated DESC');
	});

	it('bounds the changed-by clause to the requested week', async () => {
		const spy = mockIssues([]);
		await fetchJiraActivitySuggestions(config, '2026-08-03', '2026-08-09');
		const { jql } = spy.mock.calls[0]?.[1] as { jql: string };
		expect(jql).toContain('"2026-08-03"');
		expect(jql).toContain('"2026-08-09"');
	});
});
