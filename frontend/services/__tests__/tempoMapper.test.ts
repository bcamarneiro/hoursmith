import { describe, expect, it } from 'vitest';
import type { JiraIssue } from '../../../types/jira';
import { chunkIds, mapTempoWorklog, placeholderIssue } from '../tempoMapper';

const issue: JiraIssue = {
	id: '1001',
	key: 'PAY-1',
	fields: { summary: 'Do thing' },
};

describe('mapTempoWorklog', () => {
	it('maps a Tempo worklog onto EnrichedJiraWorklog with a known issue', () => {
		const out = mapTempoWorklog(
			{
				tempoWorklogId: 55,
				issue: { id: 1001 },
				timeSpentSeconds: 3600,
				startDate: '2026-06-05',
				startTime: '08:00:00',
				description: 'work',
			},
			new Map([['1001', issue]]),
			'me@x.com',
		);
		expect(out.id).toBe('55');
		expect(out.issue.key).toBe('PAY-1');
		expect(out.timeSpentSeconds).toBe(3600);
		expect(out.comment).toBe('work');
		expect(out.started).toBe('2026-06-05T08:00:00');
		expect(out.author?.emailAddress).toBe('me@x.com');
	});

	it('defaults startTime and uses startDate as the day basis', () => {
		const out = mapTempoWorklog(
			{
				tempoWorklogId: 7,
				issue: { id: 1001 },
				timeSpentSeconds: 60,
				startDate: '2026-06-30',
			},
			new Map([['1001', issue]]),
			'me@x.com',
		);
		expect(out.started).toBe('2026-06-30T00:00:00');
	});

	it('keeps Tempo real key in the placeholder when the id is not in the map (never drops)', () => {
		const out = mapTempoWorklog(
			{
				tempoWorklogId: 9,
				issue: { id: 2002, key: 'PAY-2' },
				timeSpentSeconds: 60,
				startDate: '2026-06-05',
			},
			new Map(),
			'me@x.com',
		);
		expect(out.issue.key).toBe('PAY-2');
		expect(out.issue.fields.summary).toContain('Unknown issue');
	});

	it('falls back to UNKNOWN-<id> when Tempo gives no key and the map misses', () => {
		const out = mapTempoWorklog(
			{
				tempoWorklogId: 9,
				issue: { id: 2002 },
				timeSpentSeconds: 60,
				startDate: '2026-06-05',
			},
			new Map(),
			'me@x.com',
		);
		expect(out.issue.key).toBe('UNKNOWN-2002');
	});
});

describe('chunkIds', () => {
	it('splits into chunks of the given size', () => {
		expect(chunkIds(['1', '2', '3'], 2)).toEqual([['1', '2'], ['3']]);
	});
	it('returns no chunks for an empty list', () => {
		expect(chunkIds([], 100)).toEqual([]);
	});
});

describe('placeholderIssue', () => {
	it('uses the real key when given', () => {
		expect(placeholderIssue('42', 'PAY-9')).toMatchObject({
			id: '42',
			key: 'PAY-9',
		});
	});
	it('falls back to UNKNOWN-<id> with no key', () => {
		expect(placeholderIssue('42')).toMatchObject({
			id: '42',
			key: 'UNKNOWN-42',
		});
	});
});
