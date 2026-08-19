import { describe, expect, it } from 'vitest';
import { monthWorklogsQueryKey } from '../useMonthWorklogs';

/**
 * On the Tempo path the two scopes hit different endpoints and return
 * different data — `worklogs/user/{id}` returns only the signed-in user,
 * `worklogs` returns the whole team. If the cache key does not separate them,
 * whichever surface loads first wins and the other silently reads its data.
 *
 * The damaging direction is personal-then-team: My Week populates the entry
 * with one person's rows, then Reports reads it and every teammate shows zero
 * hours, with no error to explain it.
 */
describe('monthWorklogsQueryKey', () => {
	const base = [2026, 6, 'x.atlassian.net', '', false, ''] as const;

	it('separates personal and team reads', () => {
		const personal = monthWorklogsQueryKey(...base, 'tempo', 'personal');
		const team = monthWorklogsQueryKey(...base, 'tempo', 'team');
		expect(personal).not.toEqual(team);
	});

	it('keeps one shared entry across scopes on Jira, where the data is identical', () => {
		// Both scopes hit the same Jira endpoint, so splitting them would make
		// My Week and Reports fetch the same month twice for no benefit.
		expect(monthWorklogsQueryKey(...base, 'jira', 'personal')).toEqual(
			monthWorklogsQueryKey(...base, 'jira', 'team'),
		);
	});

	it('still separates jira from tempo', () => {
		expect(monthWorklogsQueryKey(...base, 'jira', 'team')).not.toEqual(
			monthWorklogsQueryKey(...base, 'tempo', 'team'),
		);
	});

	it('is stable for the same inputs', () => {
		expect(monthWorklogsQueryKey(...base, 'tempo', 'team')).toEqual(
			monthWorklogsQueryKey(...base, 'tempo', 'team'),
		);
	});
});
