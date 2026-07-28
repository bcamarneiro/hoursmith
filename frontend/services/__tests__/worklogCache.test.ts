import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnrichedJiraWorklog } from '../../../types/jira';
import {
	buildConnectionScope,
	clearAllCache,
	clearConnectionCache,
	getCachedWorklogs,
	isIndexedDBAvailable,
	mergeWorklogs,
	storeWorklogs,
	_resetDbConnection,
} from '../worklogCache';

function makeWorklog(id: string, overrides?: Partial<EnrichedJiraWorklog>): EnrichedJiraWorklog {
	return {
		id,
		self: `https://example.atlassian.net/rest/api/2/issue/10001/worklog/${id}`,
		timeSpentSeconds: 3600,
		started: '2024-01-15T09:00:00.000+0000',
		created: '2024-01-15T09:00:00.000+0000',
		updated: '2024-01-15T09:00:00.000+0000',
		issue: { id: '10001', key: 'PROJ-1', fields: { summary: 'Test issue' } },
		...overrides,
	};
}

describe('worklogCache', () => {
	const scope = buildConnectionScope('example.atlassian.net', 'dev@example.com');

	beforeEach(() => {
		_resetDbConnection();
	});

	afterEach(async () => {
		await clearAllCache();
	});

	describe('isIndexedDBAvailable', () => {
		it('returns true when indexedDB is defined', () => {
			expect(isIndexedDBAvailable()).toBe(true);
		});
	});

	describe('buildConnectionScope', () => {
		it('normalizes host and email to lowercase', () => {
			const s = buildConnectionScope('Example.Atlassian.NET', 'Dev@Example.COM');
			expect(s).toBe('example.atlassian.net::dev@example.com');
		});

		it('trims whitespace', () => {
			const s = buildConnectionScope('  host.com  ', '  user@host.com  ');
			expect(s).toBe('host.com::user@host.com');
		});
	});

	describe('storeWorklogs / getCachedWorklogs', () => {
		it('returns null when no cache entry exists', async () => {
			const result = await getCachedWorklogs(scope, 2024, 0);
			expect(result).toBeNull();
		});

		it('stores and retrieves worklogs for a month', async () => {
			const worklogs = [makeWorklog('w1'), makeWorklog('w2')];
			await storeWorklogs(scope, 2024, 0, worklogs);

			const cached = await getCachedWorklogs(scope, 2024, 0);
			expect(cached).not.toBeNull();
			expect(cached!.worklogs).toHaveLength(2);
			expect(cached!.worklogs[0].id).toBe('w1');
			expect(cached!.lastSyncTime).toBeTruthy();
			expect(cached!.fetchedAt).toBeGreaterThan(0);
		});

		it('scopes data by connection', async () => {
			const otherScope = buildConnectionScope('other.host.com', 'other@example.com');
			const worklogs = [makeWorklog('w1')];

			await storeWorklogs(scope, 2024, 0, worklogs);

			const result = await getCachedWorklogs(otherScope, 2024, 0);
			expect(result).toBeNull();
		});

		it('scopes data by month', async () => {
			const worklogs = [makeWorklog('w1')];
			await storeWorklogs(scope, 2024, 0, worklogs);

			const result = await getCachedWorklogs(scope, 2024, 1);
			expect(result).toBeNull();
		});

		it('overwrites existing data on re-store', async () => {
			await storeWorklogs(scope, 2024, 0, [makeWorklog('w1')]);
			await storeWorklogs(scope, 2024, 0, [makeWorklog('w2'), makeWorklog('w3')]);

			const cached = await getCachedWorklogs(scope, 2024, 0);
			expect(cached!.worklogs).toHaveLength(2);
			expect(cached!.worklogs[0].id).toBe('w2');
		});
	});

	describe('mergeWorklogs', () => {
		it('creates new entry when no cache exists', async () => {
			const newWorklogs = [makeWorklog('w1')];
			const result = await mergeWorklogs(scope, 2024, 0, newWorklogs);

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('w1');

			const cached = await getCachedWorklogs(scope, 2024, 0);
			expect(cached!.worklogs).toHaveLength(1);
		});

		it('upserts by worklog id', async () => {
			await storeWorklogs(scope, 2024, 0, [
				makeWorklog('w1', { timeSpentSeconds: 3600 }),
				makeWorklog('w2', { timeSpentSeconds: 7200 }),
			]);

			// Update w1, add w3
			const updates = [
				makeWorklog('w1', { timeSpentSeconds: 1800 }),
				makeWorklog('w3', { timeSpentSeconds: 5400 }),
			];
			const result = await mergeWorklogs(scope, 2024, 0, updates);

			expect(result).toHaveLength(3);
			const w1 = result.find((w) => w.id === 'w1');
			expect(w1!.timeSpentSeconds).toBe(1800);
			const w3 = result.find((w) => w.id === 'w3');
			expect(w3).toBeTruthy();
		});
	});

	describe('clearConnectionCache', () => {
		it('clears only the specified connection scope', async () => {
			const otherScope = buildConnectionScope('other.host.com', 'other@example.com');

			await storeWorklogs(scope, 2024, 0, [makeWorklog('w1')]);
			await storeWorklogs(otherScope, 2024, 0, [makeWorklog('w2')]);

			await clearConnectionCache(scope);

			const result1 = await getCachedWorklogs(scope, 2024, 0);
			expect(result1).toBeNull();

			const result2 = await getCachedWorklogs(otherScope, 2024, 0);
			expect(result2).not.toBeNull();
			expect(result2!.worklogs).toHaveLength(1);
		});

		it('clears all months for a connection scope', async () => {
			await storeWorklogs(scope, 2024, 0, [makeWorklog('w1')]);
			await storeWorklogs(scope, 2024, 1, [makeWorklog('w2')]);

			await clearConnectionCache(scope);

			expect(await getCachedWorklogs(scope, 2024, 0)).toBeNull();
			expect(await getCachedWorklogs(scope, 2024, 1)).toBeNull();
		});
	});

	describe('clearAllCache', () => {
		it('removes all cached data', async () => {
			const otherScope = buildConnectionScope('other.host.com', 'other@example.com');

			await storeWorklogs(scope, 2024, 0, [makeWorklog('w1')]);
			await storeWorklogs(otherScope, 2024, 0, [makeWorklog('w2')]);

			await clearAllCache();

			expect(await getCachedWorklogs(scope, 2024, 0)).toBeNull();
			expect(await getCachedWorklogs(otherScope, 2024, 0)).toBeNull();
		});
	});
});
