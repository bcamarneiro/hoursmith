import { describe, expect, it } from 'vitest';
import type { JiraIssue } from '../../../types/jira';
import { classifyWorklog } from '../../react/utils/worklogClassifier';
import { deriveMonthlyReportState } from '../../react/utils/monthlyReport';
import {
	buildIssueMetadataJql,
	chunkIds,
	deriveOffsetSuffix,
	mapTempoWorklog,
	placeholderIssue,
} from '../tempoMapper';

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

describe('late-logging detection on real Tempo payloads (ADA-543)', () => {
	/**
	 * Field-for-field copy of a worklog read from a live Tempo-managed instance
	 * on 2026-08-18. Note `issue` carries no `key`, and `startTime` no offset —
	 * both were assumed otherwise before this payload was inspected.
	 */
	const realWorklog = {
		tempoWorklogId: 491168,
		issue: { id: 426364 },
		timeSpentSeconds: 14400,
		startDate: '2026-07-27',
		startTime: '09:00:00',
		startDateTimeUtc: '2026-07-27T08:00:00Z',
		createdAt: '2026-08-05T09:12:42Z',
		updatedAt: '2026-08-05T09:12:50Z',
		description: 'work',
		author: { accountId: 'acc-1' },
	};

	it('reports the true lateness instead of collapsing it to zero', () => {
		const mapped = mapTempoWorklog(realWorklog, new Map(), 'me@x.com');
		const classified = classifyWorklog(mapped);
		// Worked Jul 27, logged Aug 5. Before the fix `created` was copied from
		// `started`, so this read 0 and every Tempo user looked perfectly punctual.
		expect(classified.daysLate).toBe(9);
		expect(classified.isBackdated).toBe(true);
		expect(classified.intendedFor).toBe('2026-07-27');
		expect(classified.loggedOn).toBe('2026-08-05');
	});

	it('carries createdAt through rather than duplicating started', () => {
		const mapped = mapTempoWorklog(realWorklog, new Map(), 'me@x.com');
		expect(mapped.created).toBe('2026-08-05T09:12:42Z');
		expect(mapped.created).not.toBe(mapped.started);
	});

	it('stamps started with the offset recovered from startDateTimeUtc', () => {
		const mapped = mapTempoWorklog(realWorklog, new Map(), 'me@x.com');
		expect(mapped.started).toBe('2026-07-27T09:00:00+01:00');
	});

	it('falls back to an offset-less timestamp when startDateTimeUtc is absent', () => {
		const withoutUtc = { ...realWorklog, startDateTimeUtc: undefined };
		const mapped = mapTempoWorklog(withoutUtc, new Map(), 'me@x.com');
		expect(mapped.started).toBe('2026-07-27T09:00:00');
	});

	it('renders a placeholder key, since Tempo never sends issue.key', () => {
		const mapped = mapTempoWorklog(realWorklog, new Map(), 'me@x.com');
		expect(mapped.issue.key).toBe('UNKNOWN-426364');
	});
});

describe('deriveOffsetSuffix', () => {
	it('derives a positive offset', () => {
		expect(
			deriveOffsetSuffix('2026-07-27', '09:00:00', '2026-07-27T08:00:00Z'),
		).toBe('+01:00');
	});

	it('derives a negative offset across a date boundary', () => {
		expect(
			deriveOffsetSuffix('2026-10-31', '23:30:00', '2026-11-01T02:30:00Z'),
		).toBe('-03:00');
	});

	it('derives a half-hour offset', () => {
		expect(
			deriveOffsetSuffix('2026-07-27', '14:45:00', '2026-07-27T09:15:00Z'),
		).toBe('+05:30');
	});

	it('returns Z when local time already is UTC', () => {
		expect(
			deriveOffsetSuffix('2026-07-27', '09:00:00', '2026-07-27T09:00:00Z'),
		).toBe('Z');
	});

	it('returns empty for missing or unparseable input', () => {
		expect(deriveOffsetSuffix('2026-07-27', '09:00:00', undefined)).toBe('');
		expect(deriveOffsetSuffix('2026-07-27', '09:00:00', 'not-a-date')).toBe('');
	});

	it('rejects an absurd offset rather than emitting an unparseable stamp', () => {
		expect(
			deriveOffsetSuffix('2026-07-27', '09:00:00', '2026-07-25T09:00:00Z'),
		).toBe('');
	});
});

describe('buildIssueMetadataJql — honouring the user JQL filter on Tempo', () => {
	it('restricts to the requested issue ids when no filter is configured', () => {
		expect(buildIssueMetadataJql(['1', '2'], '')).toBe('issue in (1,2)');
	});

	it('ANDs a configured filter so it is not silently ignored', () => {
		// Tempo has no JQL, so a configured filter would otherwise vanish and the
		// user would see worklogs they had explicitly filtered out.
		expect(buildIssueMetadataJql(['1'], 'project = PAY')).toBe(
			'issue in (1) AND (project = PAY)',
		);
	});

	it('parenthesises the filter so an OR cannot widen the id restriction', () => {
		expect(buildIssueMetadataJql(['1'], 'a = 1 OR b = 2')).toBe(
			'issue in (1) AND (a = 1 OR b = 2)',
		);
	});

	it('ignores a whitespace-only filter', () => {
		expect(buildIssueMetadataJql(['1'], '   ')).toBe('issue in (1)');
	});
});

describe('author identity survives into Reports', () => {
	const worklog = {
		tempoWorklogId: 1,
		issue: { id: 1001 },
		timeSpentSeconds: 3600,
		startDate: '2026-07-27',
		startTime: '09:00:00',
		createdAt: '2026-07-27T09:00:00Z',
		description: 'work',
		author: { accountId: 'acc-1' },
	};
	const issue = {
		id: '1001',
		key: 'PAY-1',
		fields: { summary: 'Ship the thing' },
	};

	it('carries a displayName, which Reports requires to group at all', () => {
		const mapped = mapTempoWorklog(
			worklog,
			new Map([['1001', issue]]),
			'me@x.com',
			'Bruno Camarneiro',
		);
		expect(mapped.author?.displayName).toBe('Bruno Camarneiro');
	});

	it('appears in the monthly report instead of being silently dropped', () => {
		const mapped = mapTempoWorklog(
			worklog,
			new Map([['1001', issue]]),
			'me@x.com',
			'Bruno Camarneiro',
		);
		// deriveMonthlyReportState skips any worklog with no author.displayName,
		// so a Tempo worklog without one vanishes from Reports with no error —
		// the page just says "No worklogs found".
		const state = deriveMonthlyReportState([mapped], '', '');
		expect(state.users).toHaveLength(1);
		expect(state.visibleEntries).toHaveLength(1);
	});

	it('falls back to the email when no display name is known', () => {
		const mapped = mapTempoWorklog(
			worklog,
			new Map([['1001', issue]]),
			'me@x.com',
		);
		// Still must be non-empty, or the row disappears from Reports.
		expect(mapped.author?.displayName).toBe('me@x.com');
	});

	it('falls back to the accountId when neither name nor email is known', () => {
		const mapped = mapTempoWorklog(worklog, new Map([['1001', issue]]), '');
		expect(mapped.author?.displayName).toBe('acc-1');
	});
});
