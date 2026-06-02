import { beforeEach, describe, expect, it } from 'vitest';
import { migrateStorageKey } from '../migrateStorageKeys';

const LEGACY = 'jira-timesheet-config';
const CURRENT = 'hoursmith-config';

describe('migrateStorageKey (jira-timesheet-report → hoursmith rename)', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('carries the legacy value forward and drops the legacy key', () => {
		const value = JSON.stringify({ state: { config: { jiraHost: 'x' } } });
		localStorage.setItem(LEGACY, value);

		migrateStorageKey(LEGACY, CURRENT);

		expect(localStorage.getItem(CURRENT)).toBe(value);
		expect(localStorage.getItem(LEGACY)).toBeNull();
	});

	it('never clobbers an existing current value with stale legacy data', () => {
		localStorage.setItem(CURRENT, 'fresh');
		localStorage.setItem(LEGACY, 'stale');

		migrateStorageKey(LEGACY, CURRENT);

		expect(localStorage.getItem(CURRENT)).toBe('fresh');
	});

	it('is a no-op on a fresh install (neither key present)', () => {
		migrateStorageKey(LEGACY, CURRENT);

		expect(localStorage.getItem(CURRENT)).toBeNull();
		expect(localStorage.getItem(LEGACY)).toBeNull();
	});

	it('is idempotent — a second call does not lose the migrated data', () => {
		localStorage.setItem(LEGACY, 'data');

		migrateStorageKey(LEGACY, CURRENT);
		migrateStorageKey(LEGACY, CURRENT);

		expect(localStorage.getItem(CURRENT)).toBe('data');
		expect(localStorage.getItem(LEGACY)).toBeNull();
	});
});
