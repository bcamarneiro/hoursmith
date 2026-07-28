import { describe, expect, it } from 'vitest';
import { mergeWorklogs } from './worklogCache';
import type { EnrichedJiraWorklog } from '../../types/jira';

function makeWorklog(overrides: Partial<EnrichedJiraWorklog> = {}): EnrichedJiraWorklog {
	return {
		id: 'wl-1',
		issue: { key: 'PROJ-1' },
		started: '2025-01-15T10:00:00.000+0000',
		timeSpentSeconds: 3600,
		author: { displayName: 'Test User', emailAddress: 'test@example.com' },
		...overrides,
	} as EnrichedJiraWorklog;
}

describe('mergeWorklogs', () => {
	it('returns cached worklogs when delta is empty', () => {
		const cached = [makeWorklog({ id: 'wl-1' }), makeWorklog({ id: 'wl-2' })];
		const result = mergeWorklogs(cached, []);
		expect(result).toHaveLength(2);
	});

	it('adds new worklogs from delta', () => {
		const cached = [makeWorklog({ id: 'wl-1' })];
		const delta = [makeWorklog({ id: 'wl-2' })];
		const result = mergeWorklogs(cached, delta);
		expect(result).toHaveLength(2);
	});

	it('replaces older worklog with newer one (same id, newer updated)', () => {
		const cached = [
			makeWorklog({ id: 'wl-1', timeSpentSeconds: 3600, updated: '2025-01-15T12:00:00.000+0000' }),
		];
		const delta = [
			makeWorklog({ id: 'wl-1', timeSpentSeconds: 7200, updated: '2025-01-15T14:00:00.000+0000' }),
		];
		const result = mergeWorklogs(cached, delta);
		expect(result).toHaveLength(1);
		expect(result[0].timeSpentSeconds).toBe(7200);
	});

	it('keeps cached worklog when it is newer than delta', () => {
		const cached = [
			makeWorklog({ id: 'wl-1', timeSpentSeconds: 7200, updated: '2025-01-15T14:00:00.000+0000' }),
		];
		const delta = [
			makeWorklog({ id: 'wl-1', timeSpentSeconds: 3600, updated: '2025-01-15T12:00:00.000+0000' }),
		];
		const result = mergeWorklogs(cached, delta);
		expect(result).toHaveLength(1);
		expect(result[0].timeSpentSeconds).toBe(7200);
	});

	it('treats different synthetic keys as distinct when id is missing', () => {
		const cached = [
			makeWorklog({
				id: undefined,
				issue: { key: 'PROJ-1' },
				started: '2025-01-15T10:00:00.000+0000',
				timeSpentSeconds: 3600,
			}),
		];
		const delta = [
			makeWorklog({
				id: undefined,
				issue: { key: 'PROJ-1' },
				started: '2025-01-15T10:00:00.000+0000',
				timeSpentSeconds: 7200,
				updated: '2025-01-15T14:00:00.000+0000',
			}),
		];
		// Synthetic key includes timeSpentSeconds, so different durations
		// produce different keys — both entries are kept.
		const result = mergeWorklogs(cached, delta);
		expect(result).toHaveLength(2);
	});

	it('returns empty array when both inputs are empty', () => {
		expect(mergeWorklogs([], [])).toEqual([]);
	});
});
