import { describe, expect, it } from 'vitest';
import { assertWritableRow } from '../worklogWriteRouter';

/**
 * Jira worklog ids and Tempo worklog ids are different id spaces, and in
 * `auto` mode the active source can change *mid-session*: the first read is
 * Jira (detection has not run yet), which populates the store with Jira ids;
 * detection then flips the source to Tempo.
 *
 * If the user edits or deletes a row in that window, the Jira id is sent to
 * `PUT`/`DELETE /4/worklogs/{id}` — which either 404s or, worse, hits an
 * unrelated Tempo worklog that happens to share the number. Deleting someone
 * else's time entry is the worst outcome in this integration, so the guard
 * refuses rather than guesses.
 */
describe('assertWritableRow', () => {
	it('allows a tempo row while tempo is the active source', () => {
		expect(() =>
			assertWritableRow({ id: '1', worklogSource: 'tempo' }, 'tempo'),
		).not.toThrow();
	});

	it('allows a jira row while jira is the active source', () => {
		expect(() => assertWritableRow({ id: '1' }, 'jira')).not.toThrow();
	});

	it('refuses a jira row once the source has flipped to tempo', () => {
		expect(() => assertWritableRow({ id: '1' }, 'tempo')).toThrow(/refresh/i);
	});

	it('refuses a tempo row once the source has flipped to jira', () => {
		expect(() =>
			assertWritableRow({ id: '1', worklogSource: 'tempo' }, 'jira'),
		).toThrow(/refresh/i);
	});

	it('allows the write when the row is unknown, rather than blocking valid work', () => {
		// A row absent from the store (e.g. just created in another view) must
		// not be blocked — the guard exists to catch a known mismatch, not to
		// gate every write on cache completeness.
		expect(() => assertWritableRow(undefined, 'tempo')).not.toThrow();
	});
});
