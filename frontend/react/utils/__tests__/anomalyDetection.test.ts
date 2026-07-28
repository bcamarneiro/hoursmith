import { describe, expect, it } from 'vitest';
import type { JiraWorklog } from '../../../../types/jira';
import {
	computeDayStats,
	detectDayAnomalies,
	detectDuplicates,
	detectRoundHours,
	detectUnderLogged,
} from '../anomalyDetection';
import { BASELINE_DAY_SECONDS } from '../dayTarget';

// ── Helpers ─────────────────────────────────────────────────────────────────

function wl(overrides: Partial<JiraWorklog> = {}): JiraWorklog {
	return {
		id: '10001',
		issueKey: 'PROJ-1',
		timeSpentSeconds: 3600,
		started: '2026-03-02T09:00:00.000+0000',
		created: '2026-03-02T09:00:00.000+0000',
		...overrides,
	};
}

// ── computeDayStats ─────────────────────────────────────────────────────────

describe('computeDayStats', () => {
	it('returns zero stats for an empty day', () => {
		const stats = computeDayStats('2026-03-02', []);
		expect(stats).toEqual({
			day: '2026-03-02',
			totalSeconds: 0,
			entryCount: 0,
			uniqueIssues: [],
		});
	});

	it('sums seconds and collects unique issues', () => {
		const worklogs = [
			wl({ issueKey: 'A-1', timeSpentSeconds: 1800 }),
			wl({ issueKey: 'B-2', timeSpentSeconds: 3600 }),
			wl({ issueKey: 'A-1', timeSpentSeconds: 900 }),
		];
		const stats = computeDayStats('2026-03-02', worklogs);
		expect(stats.totalSeconds).toBe(6300);
		expect(stats.entryCount).toBe(3);
		expect(stats.uniqueIssues).toEqual(['A-1', 'B-2']);
	});

	it('handles worklogs with missing timeSpentSeconds', () => {
		const worklogs = [wl({ timeSpentSeconds: undefined })];
		const stats = computeDayStats('2026-03-02', worklogs);
		expect(stats.totalSeconds).toBe(0);
		expect(stats.entryCount).toBe(1);
	});

	it('handles worklogs with missing issueKey', () => {
		const worklogs = [wl({ issueKey: undefined, timeSpentSeconds: 1800 })];
		const stats = computeDayStats('2026-03-02', worklogs);
		expect(stats.totalSeconds).toBe(1800);
		expect(stats.uniqueIssues).toEqual([]);
	});
});

// ── detectUnderLogged ───────────────────────────────────────────────────────

describe('detectUnderLogged', () => {
	it('returns null when logged meets target', () => {
		const stats = computeDayStats('2026-03-02', [
			wl({ timeSpentSeconds: BASELINE_DAY_SECONDS }),
		]);
		expect(detectUnderLogged(stats, BASELINE_DAY_SECONDS)).toBeNull();
	});

	it('flags a day with zero entries on a weekday', () => {
		const stats = computeDayStats('2026-03-02', []);
		const reason = detectUnderLogged(stats, BASELINE_DAY_SECONDS);
		expect(reason).not.toBeNull();
		expect(reason?.kind).toBe('under-logged');
		expect(reason?.loggedSeconds).toBe(0);
		expect(reason?.ratio).toBe(0);
	});

	it('flags a day below the default 50% threshold', () => {
		const stats = computeDayStats('2026-03-02', [
			wl({ timeSpentSeconds: 3600 }), // 1 h of 8 h target
		]);
		const reason = detectUnderLogged(stats, BASELINE_DAY_SECONDS);
		expect(reason).not.toBeNull();
		expect(reason?.ratio).toBeCloseTo(3600 / BASELINE_DAY_SECONDS);
	});

	it('does not flag when above threshold', () => {
		const stats = computeDayStats('2026-03-02', [
			wl({ timeSpentSeconds: 5 * 3600 }), // 5 h of 8 h → 62.5%
		]);
		expect(detectUnderLogged(stats, BASELINE_DAY_SECONDS)).toBeNull();
	});

	it('respects a custom threshold', () => {
		const stats = computeDayStats('2026-03-02', [
			wl({ timeSpentSeconds: 3 * 3600 }), // 3 h of 8 h → 37.5%
		]);
		// Default 50% → flagged.
		expect(detectUnderLogged(stats, BASELINE_DAY_SECONDS)).not.toBeNull();
		// Custom 25% → not flagged.
		expect(
			detectUnderLogged(stats, BASELINE_DAY_SECONDS, { threshold: 0.25 }),
		).toBeNull();
	});

	it('never flags when target is 0 (weekend / full absence)', () => {
		const stats = computeDayStats('2026-03-02', []);
		expect(detectUnderLogged(stats, 0)).toBeNull();
	});
});

// ── detectDuplicates ────────────────────────────────────────────────────────

describe('detectDuplicates', () => {
	it('returns empty for distinct worklogs', () => {
		const worklogs = [
			wl({ id: '1', issueKey: 'A-1', timeSpentSeconds: 1800 }),
			wl({ id: '2', issueKey: 'A-1', timeSpentSeconds: 3600 }),
			wl({ id: '3', issueKey: 'B-2', timeSpentSeconds: 1800 }),
		];
		expect(detectDuplicates(worklogs)).toEqual([]);
	});

	it('detects same issue + same time as duplicate', () => {
		const worklogs = [
			wl({ id: '1', issueKey: 'A-1', timeSpentSeconds: 3600 }),
			wl({ id: '2', issueKey: 'A-1', timeSpentSeconds: 3600 }),
		];
		const reasons = detectDuplicates(worklogs);
		expect(reasons).toHaveLength(1);
		expect(reasons[0].kind).toBe('duplicate');
		expect(reasons[0].issueKey).toBe('A-1');
		expect(reasons[0].timeSpentSeconds).toBe(3600);
		expect(reasons[0].worklogIds).toEqual(['1', '2']);
	});

	it('detects multiple duplicate clusters', () => {
		const worklogs = [
			wl({ id: '1', issueKey: 'A-1', timeSpentSeconds: 3600 }),
			wl({ id: '2', issueKey: 'A-1', timeSpentSeconds: 3600 }),
			wl({ id: '3', issueKey: 'B-2', timeSpentSeconds: 1800 }),
			wl({ id: '4', issueKey: 'B-2', timeSpentSeconds: 1800 }),
		];
		const reasons = detectDuplicates(worklogs);
		expect(reasons).toHaveLength(2);
	});

	it('ignores worklogs missing issueKey or timeSpentSeconds', () => {
		const worklogs = [
			wl({ id: '1', issueKey: undefined, timeSpentSeconds: 3600 }),
			wl({ id: '2', issueKey: undefined, timeSpentSeconds: 3600 }),
			wl({ id: '3', issueKey: 'A-1', timeSpentSeconds: undefined }),
			wl({ id: '4', issueKey: 'A-1', timeSpentSeconds: undefined }),
		];
		expect(detectDuplicates(worklogs)).toEqual([]);
	});

	it('handles worklogs without ids', () => {
		const worklogs = [
			wl({ id: undefined, issueKey: 'A-1', timeSpentSeconds: 3600 }),
			wl({ id: undefined, issueKey: 'A-1', timeSpentSeconds: 3600 }),
		];
		const reasons = detectDuplicates(worklogs);
		expect(reasons).toHaveLength(1);
		expect(reasons[0].worklogIds).toEqual(['', '']);
	});
});

// ── detectRoundHours ────────────────────────────────────────────────────────

describe('detectRoundHours', () => {
	it('flags exact whole-hour worklogs', () => {
		const worklogs = [
			wl({ id: '1', issueKey: 'A-1', timeSpentSeconds: 3600 }),
			wl({ id: '2', issueKey: 'B-2', timeSpentSeconds: 7200 }),
			wl({ id: '3', issueKey: 'C-3', timeSpentSeconds: 28800 }), // 8 h
		];
		const reasons = detectRoundHours(worklogs);
		expect(reasons).toHaveLength(3);
		expect(reasons[0].wholeHours).toBe(1);
		expect(reasons[1].wholeHours).toBe(2);
		expect(reasons[2].wholeHours).toBe(8);
	});

	it('does not flag non-round worklogs', () => {
		const worklogs = [
			wl({ timeSpentSeconds: 2700 }), // 45 min
			wl({ timeSpentSeconds: 5400 }), // 1.5 h
			wl({ timeSpentSeconds: 180 }), // 3 min
		];
		expect(detectRoundHours(worklogs)).toEqual([]);
	});

	it('respects minHours option', () => {
		const worklogs = [
			wl({ id: '1', timeSpentSeconds: 3600 }), // 1 h
			wl({ id: '2', timeSpentSeconds: 7200 }), // 2 h
		];
		// Default minHours = 1 → both flagged.
		expect(detectRoundHours(worklogs)).toHaveLength(2);
		// minHours = 2 → only 2 h flagged.
		const filtered = detectRoundHours(worklogs, { minHours: 2 });
		expect(filtered).toHaveLength(1);
		expect(filtered[0].wholeHours).toBe(2);
	});

	it('ignores zero and negative values', () => {
		const worklogs = [
			wl({ timeSpentSeconds: 0 }),
			wl({ timeSpentSeconds: -3600 }),
			wl({ timeSpentSeconds: undefined }),
		];
		expect(detectRoundHours(worklogs)).toEqual([]);
	});
});

// ── detectDayAnomalies (combined) ──────────────────────────────────────────

describe('detectDayAnomalies', () => {
	it('returns no reasons for a normal day', () => {
		const worklogs = [
			wl({ id: '1', issueKey: 'A-1', timeSpentSeconds: 17100 }), // 4 h 45 m
			wl({ id: '2', issueKey: 'B-2', timeSpentSeconds: 13500 }), // 3 h 45 m
		];
		const result = detectDayAnomalies('2026-03-02', worklogs);
		expect(result.stats.totalSeconds).toBe(30600);
		expect(result.reasons).toEqual([]);
	});

	it('aggregates multiple anomaly kinds', () => {
		const worklogs = [
			wl({ id: '1', issueKey: 'A-1', timeSpentSeconds: 3600 }), // round + under-logged
			wl({ id: '2', issueKey: 'A-1', timeSpentSeconds: 3600 }), // duplicate of #1
		];
		const result = detectDayAnomalies('2026-03-02', worklogs);
		const kinds = result.reasons.map((r) => r.kind);
		expect(kinds).toContain('under-logged');
		expect(kinds).toContain('duplicate');
		expect(kinds).toContain('round-hours');
	});

	it('uses default 8 h target when none provided', () => {
		const worklogs = [wl({ timeSpentSeconds: 3600 })]; // 1 h → under-logged
		const result = detectDayAnomalies('2026-03-02', worklogs);
		const underLogged = result.reasons.find((r) => r.kind === 'under-logged');
		expect(underLogged).toBeDefined();
		expect((underLogged as { targetSeconds: number }).targetSeconds).toBe(
			BASELINE_DAY_SECONDS,
		);
	});

	it('is deterministic — same input always yields same output', () => {
		const worklogs = [
			wl({ id: '1', issueKey: 'A-1', timeSpentSeconds: 3600 }),
			wl({ id: '2', issueKey: 'A-1', timeSpentSeconds: 3600 }),
		];
		const a = detectDayAnomalies('2026-03-02', worklogs);
		const b = detectDayAnomalies('2026-03-02', worklogs);
		expect(a).toEqual(b);
	});
});
