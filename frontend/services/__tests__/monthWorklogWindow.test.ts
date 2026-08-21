import { describe, expect, it } from 'vitest';
import type { EmbeddedWorklog } from '../monthWorklogService';
import { worklogBelongsToMonth } from '../monthWorklogService';

function worklog(over: Partial<EmbeddedWorklog>): EmbeddedWorklog {
	return {
		id: '1',
		timeSpentSeconds: 28800,
		started: '2025-10-06T09:00:00.000-0300',
		created: '2025-10-06T09:00:00.000-0300',
		...over,
	} as EmbeddedWorklog;
}

const SEP = { from: '2025-09-01', to: '2025-09-30' };
const OCT = { from: '2025-10-01', to: '2025-10-31' };

describe('worklogBelongsToMonth', () => {
	it('keeps an ordinary worklog in its own month and not the next', () => {
		const wl = worklog({});
		expect(worklogBelongsToMonth(wl, OCT.from, OCT.to)).toBe(true);
		expect(worklogBelongsToMonth(wl, SEP.from, SEP.to)).toBe(false);
	});

	// The regression. Jira is asked for `worklogDate` (the *started* date), so a
	// jira-native backdate — started in September, entered in October — is only
	// ever delivered by September's request. Filtering the response on loggedOn
	// alone threw it away there, and October never asked for it: the worklog fell
	// through the gap between two months and vanished from Reports entirely.
	it('keeps a jira-native backdate in the month it was fetched by', () => {
		const backdated = worklog({
			id: '68',
			started: '2025-09-26T09:00:00.000-0300',
			created: '2025-10-06T15:00:00.000-0300',
			comment: 'Reconciled later (no marker)',
		});
		expect(worklogBelongsToMonth(backdated, SEP.from, SEP.to)).toBe(true);
	});

	it('also keeps it in the month it was logged, for the totals', () => {
		const backdated = worklog({
			id: '68',
			started: '2025-09-26T09:00:00.000-0300',
			created: '2025-10-06T15:00:00.000-0300',
			comment: 'Reconciled later (no marker)',
		});
		expect(worklogBelongsToMonth(backdated, OCT.from, OCT.to)).toBe(true);
	});

	it('keeps a comment-marked backdate in both months too', () => {
		const marked = worklog({
			id: '44',
			started: '2025-10-05T14:00:00.000-0300',
			created: '2025-10-05T14:00:00.000-0300',
			comment: 'Late entry. Original Worklog Date was: 2025/09/25',
		});
		expect(worklogBelongsToMonth(marked, OCT.from, OCT.to)).toBe(true);
		expect(worklogBelongsToMonth(marked, SEP.from, SEP.to)).toBe(true);
	});

	it('excludes a worklog unrelated to the month on either date', () => {
		const wl = worklog({
			started: '2025-12-01T09:00:00.000-0300',
			created: '2025-12-01T09:00:00.000-0300',
		});
		expect(worklogBelongsToMonth(wl, SEP.from, SEP.to)).toBe(false);
		expect(worklogBelongsToMonth(wl, OCT.from, OCT.to)).toBe(false);
	});
});
