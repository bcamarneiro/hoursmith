import { describe, expect, it } from 'vitest';
import type { JiraIssue } from '../../../types/jira';
import { mapTempoWriteResponse } from '../tempoWriteService';

/**
 * Tempo's write endpoints echo a *Tempo* worklog, not a Jira one. Putting that
 * shape straight into the timesheet store leaves the row with no `id` and no
 * `started`, which breaks it in ways that look unrelated to the save:
 *
 *   - `worklogMonth()` returns null, so the month cache is never patched and
 *     the new row vanishes on the next render pass;
 *   - the row renders without a date;
 *   - later edit/delete match on `wl.id === worklogId` and never hit, so the
 *     row becomes uneditable.
 */
describe('mapTempoWriteResponse', () => {
	const issue: JiraIssue = {
		id: '426364',
		key: 'PAY-1',
		fields: { summary: 'Ship it' },
	};

	const tempoResponse = {
		tempoWorklogId: 491168,
		issue: { id: 426364 },
		timeSpentSeconds: 3600,
		startDate: '2026-07-27',
		startTime: '09:00:00',
		startDateTimeUtc: '2026-07-27T08:00:00Z',
		createdAt: '2026-08-05T09:12:42Z',
		description: 'work',
		author: { accountId: 'acc-1' },
	};

	it('gives the row an id, so a later edit or delete can find it', () => {
		const out = mapTempoWriteResponse(tempoResponse, issue, 'me@x.com');
		expect(out?.id).toBe('491168');
	});

	it('gives the row a started date, so it lands in the right month', () => {
		const out = mapTempoWriteResponse(tempoResponse, issue, 'me@x.com');
		expect(out?.started).toBe('2026-07-27T09:00:00+01:00');
	});

	it('keeps the issue the caller already resolved', () => {
		const out = mapTempoWriteResponse(tempoResponse, issue, 'me@x.com');
		expect(out?.issue.key).toBe('PAY-1');
		expect(out?.issue.fields.summary).toBe('Ship it');
	});

	it('carries the comment and duration through', () => {
		const out = mapTempoWriteResponse(tempoResponse, issue, 'me@x.com');
		expect(out?.comment).toBe('work');
		expect(out?.timeSpentSeconds).toBe(3600);
	});

	it('carries a display name, without which Reports would drop the row', () => {
		const out = mapTempoWriteResponse(
			tempoResponse,
			issue,
			'me@x.com',
			'Bruno C',
		);
		expect(out?.author?.displayName).toBe('Bruno C');
	});
});

describe('mapTempoWriteResponse — unusable responses', () => {
	const issue: JiraIssue = {
		id: '426364',
		key: 'PAY-1',
		fields: { summary: 'Ship it' },
	};
	const sent = {
		issueKey: 'PAY-1',
		timeSpentSeconds: 3600,
		startDate: '2026-07-27',
		startTime: '09:00:00',
		description: 'work',
	};

	it('rebuilds the row from the request when Tempo echoes no issue', () => {
		const out = mapTempoWriteResponse(
			{ tempoWorklogId: 491168 },
			issue,
			'me@x.com',
			undefined,
			sent,
		);
		// Never fabricated: the date must come from what we sent, because a row
		// with no date makes worklogMonth() null, and patchMonthCaches reads a
		// null month as "every month" — one bad response would otherwise land a
		// dateless row in every cached month at once.
		expect(out?.started).toBe('2026-07-27T09:00:00');
		expect(out?.id).toBe('491168');
		expect(out?.timeSpentSeconds).toBe(3600);
	});

	it('returns null rather than a placeholder when there is no id to use', () => {
		expect(
			mapTempoWriteResponse(null, issue, 'me@x.com', undefined, sent),
		).toBeNull();
	});

	it('returns null when nothing was sent and nothing came back', () => {
		expect(mapTempoWriteResponse(null, issue, 'me@x.com')).toBeNull();
	});
});
