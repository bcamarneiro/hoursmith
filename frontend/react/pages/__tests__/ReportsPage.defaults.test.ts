import { describe, expect, it } from 'vitest';
import { DEFAULT_SORT_DIRECTION, DEFAULT_SORT_FIELD } from '../ReportsPage';

// ADA-435: the weekly team view must land on "who's behind first" — the lead's
// recurring task is chasing the gap, so the largest shortfall belongs on top,
// not alphabetical order. This pins the landing default so a future refactor
// can't silently revert it back to name/asc. A shared `?sort=`/`?dir=` link
// still overrides these at runtime (useReportsURLState).
describe('Reports default sort (ADA-435)', () => {
	it('lands on the gap, largest shortfall first', () => {
		expect(DEFAULT_SORT_FIELD).toBe('gap');
		expect(DEFAULT_SORT_DIRECTION).toBe('desc');
	});
});
