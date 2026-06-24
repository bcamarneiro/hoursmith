import { describe, expect, it } from 'vitest';
import type { WorklogSuggestion } from '../../../types/Suggestion';
import {
	distributeSuggestionsToFillGap,
	mergeSuggestions,
	roundingStepSeconds,
} from '../suggestionMerger';

function makeSuggestion(
	overrides: Partial<WorklogSuggestion> = {},
): WorklogSuggestion {
	return {
		id: 'test-1',
		source: 'jira-activity',
		issueKey: 'TEST-1',
		issueSummary: 'Test issue',
		date: '2026-03-09',
		suggestedTimeSpent: '1h',
		suggestedSeconds: 3600,
		confidence: 'medium',
		reason: 'Test reason',
		logged: false,
		...overrides,
	};
}

describe('distributeSuggestionsToFillGap', () => {
	it('should return empty array for empty suggestions', () => {
		const result = distributeSuggestionsToFillGap([], 28800);
		expect(result).toEqual([]);
	});

	it('should return suggestions unchanged when gap is zero', () => {
		const suggestions = [makeSuggestion({ suggestedSeconds: 3600 })];
		const result = distributeSuggestionsToFillGap(suggestions, 0);
		expect(result).toEqual(suggestions);
	});

	it('should return suggestions unchanged when gap is negative', () => {
		const suggestions = [makeSuggestion({ suggestedSeconds: 3600 })];
		const result = distributeSuggestionsToFillGap(suggestions, -1000);
		expect(result).toEqual(suggestions);
	});

	it('should return suggestions unchanged when total already exceeds gap', () => {
		const suggestions = [makeSuggestion({ suggestedSeconds: 28800 })];
		const result = distributeSuggestionsToFillGap(suggestions, 7200);
		expect(result).toEqual(suggestions);
	});

	it('should return suggestions unchanged when total equals gap', () => {
		const suggestions = [makeSuggestion({ suggestedSeconds: 28800 })];
		const result = distributeSuggestionsToFillGap(suggestions, 28800);
		expect(result).toEqual(suggestions);
	});

	it('should scale a single suggestion to fill the gap exactly', () => {
		const suggestions = [
			makeSuggestion({ suggestedSeconds: 3600 }), // 1h
		];
		const gapSeconds = 28800; // 8h

		const result = distributeSuggestionsToFillGap(suggestions, gapSeconds);

		expect(result).toHaveLength(1);
		expect(result[0].suggestedSeconds).toBe(28800);
		expect(result[0].suggestedTimeSpent).toBe('8h');
	});

	it('should scale multiple suggestions proportionally to fill the gap', () => {
		const suggestions = [
			makeSuggestion({ id: 's1', suggestedSeconds: 3600 }), // 1h
			makeSuggestion({ id: 's2', suggestedSeconds: 7200 }), // 2h
		];
		const gapSeconds = 28800; // 8h, total is 3h, scale factor ~2.667

		const result = distributeSuggestionsToFillGap(suggestions, gapSeconds);

		expect(result).toHaveLength(2);

		// Total must equal gap exactly
		const total = result.reduce((sum, s) => sum + s.suggestedSeconds, 0);
		expect(total).toBe(28800);

		// Proportions should be preserved (1:2 ratio)
		// s1 was 1/3 of total -> ~9600, s2 was 2/3 -> ~19200
		expect(result[0].suggestedSeconds).toBeCloseTo(9600, -1);
		expect(result[1].suggestedSeconds).toBeCloseTo(19200, -1);
	});

	it('should preserve suggestion properties other than time fields', () => {
		const suggestions = [
			makeSuggestion({
				id: 'keep-me',
				issueKey: 'PROJ-42',
				confidence: 'high',
				source: 'gitlab',
				suggestedSeconds: 1800,
			}),
		];

		const result = distributeSuggestionsToFillGap(suggestions, 7200);

		expect(result[0].id).toBe('keep-me');
		expect(result[0].issueKey).toBe('PROJ-42');
		expect(result[0].confidence).toBe('high');
		expect(result[0].source).toBe('gitlab');
		expect(result[0].suggestedSeconds).toBe(7200);
	});

	it('should handle rounding so total matches gap exactly', () => {
		// Three suggestions that won't divide evenly
		const suggestions = [
			makeSuggestion({ id: 's1', suggestedSeconds: 1000 }),
			makeSuggestion({ id: 's2', suggestedSeconds: 1000 }),
			makeSuggestion({ id: 's3', suggestedSeconds: 1000 }),
		];
		const gapSeconds = 10000; // 10000 / 3000 = 3.333...

		const result = distributeSuggestionsToFillGap(suggestions, gapSeconds);

		const total = result.reduce((sum, s) => sum + s.suggestedSeconds, 0);
		expect(total).toBe(10000);
	});

	it('should update suggestedTimeSpent to match new seconds', () => {
		const suggestions = [
			makeSuggestion({ suggestedSeconds: 1800 }), // 30m
		];

		const result = distributeSuggestionsToFillGap(suggestions, 7200); // scale to 2h

		expect(result[0].suggestedSeconds).toBe(7200);
		expect(result[0].suggestedTimeSpent).toBe('2h');
	});
});

describe('mergeSuggestions: week date generation', () => {
	it('produces 7 consecutive YYYY-MM-DD strings starting at weekStart, regardless of viewer TZ', () => {
		// Regression: the previous implementation used
		// `new Date(weekStart).toISOString().slice(0, 10)`, which interprets
		// the YYYY-MM-DD string as UTC midnight and then re-serialises in UTC.
		// In viewers west of UTC this could shift the first day backward by
		// one (e.g. "2025-10-06" -> "2025-10-05"). With the local-TZ helper
		// the result is stable.
		const result = mergeSuggestions({
			weekStart: '2025-10-06',
			jiraSuggestions: [],
			gitlabSuggestions: [],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			existingWorklogs: [],
		});

		expect(result.map((d) => d.date)).toEqual([
			'2025-10-06',
			'2025-10-07',
			'2025-10-08',
			'2025-10-09',
			'2025-10-10',
			'2025-10-11',
			'2025-10-12',
		]);
	});

	it('handles a DST spring-forward boundary without dropping or duplicating a day', () => {
		// 2026-03-08 is the US DST spring-forward Sunday. A naive
		// addDays-via-Date.setDate around this boundary can yield a duplicate
		// or skipped day in some TZs; addDaysToIsoDate parses local and
		// re-formats so each step is exactly one calendar day.
		const result = mergeSuggestions({
			weekStart: '2026-03-02',
			jiraSuggestions: [],
			gitlabSuggestions: [],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			existingWorklogs: [],
		});

		expect(result.map((d) => d.date)).toEqual([
			'2026-03-02',
			'2026-03-03',
			'2026-03-04',
			'2026-03-05',
			'2026-03-06',
			'2026-03-07',
			'2026-03-08',
		]);
	});
});

describe('mergeSuggestions', () => {
	it('sets zero target on attributed time-off weekdays', () => {
		const result = mergeSuggestions({
			weekStart: '2026-03-09',
			jiraSuggestions: [],
			gitlabSuggestions: [],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			existingWorklogs: [],
			absenceDays: new Map([
				[
					'2026-03-10',
					{
						date: '2026-03-10',
						reasons: ['Bruno C - Vacation'],
						kind: 'vacation',
					},
				],
			]),
		});

		const day = result.find((entry) => entry.date === '2026-03-10');
		expect(day?.targetSeconds).toBe(0);
		expect(day?.gapSeconds).toBe(0);
		expect(day?.absenceKind).toBe('vacation');
	});
});

describe('mergeSuggestions: classifier contract for existingWorklogs', () => {
	// Contract: `existingWorklogs[i].date` is the *logged-policy* day (i.e.
	// `classifyWorklog(wl).loggedOn`), populated upstream by
	// useDashboardDataFetcher.deriveWeekWorklogs. The merger relies on this
	// to suppress duplicate suggestions only for the day a worklog actually
	// counts toward — never for the (possibly older) intended day a backdated
	// entry references.
	//
	// Pattern A example: a worklog logged on 2026-04-22 with a comment marker
	// pointing to 2026-04-15 must show up in `existingWorklogs` as
	// { date: '2026-04-22' }. A suggestion that targets the intended day
	// (2026-04-15) for the same issue must NOT be suppressed — the user has
	// not yet logged anything for that day.
	it('does not suppress a suggestion for the intended day when a Pattern A backdated entry covers the logged-on day', () => {
		const result = mergeSuggestions({
			weekStart: '2026-04-13', // Mon-Sun: 2026-04-13..2026-04-19
			jiraSuggestions: [
				makeSuggestion({
					id: 'jira-PROJ-1-2026-04-15',
					issueKey: 'PROJ-1',
					date: '2026-04-15',
					suggestedSeconds: 3600,
					confidence: 'medium',
				}),
			],
			gitlabSuggestions: [],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			// Pattern A: backdated entry's classifier-derived loggedOn is
			// 2026-04-22 (next week). Even though the user "intended" it for
			// 2026-04-15, the merger sees the logged-policy date.
			existingWorklogs: [
				{
					date: '2026-04-22',
					issueKey: 'PROJ-1',
					timeSpentSeconds: 3600,
				},
			],
		});

		const intendedDay = result.find((d) => d.date === '2026-04-15');
		expect(intendedDay).toBeDefined();
		const survivingForIssue = intendedDay?.suggestions.filter(
			(s) => s.issueKey === 'PROJ-1',
		);
		expect(survivingForIssue?.length).toBeGreaterThan(0);
	});

	it('still suppresses a suggestion when existingWorklogs.date matches the suggestion date and issueKey', () => {
		// Sanity baseline: when the logged-policy date does match, dedup works.
		const result = mergeSuggestions({
			weekStart: '2026-04-13',
			jiraSuggestions: [
				makeSuggestion({
					id: 'jira-PROJ-1-2026-04-15',
					issueKey: 'PROJ-1',
					date: '2026-04-15',
					suggestedSeconds: 3600,
				}),
			],
			gitlabSuggestions: [],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			existingWorklogs: [
				{
					date: '2026-04-15',
					issueKey: 'PROJ-1',
					timeSpentSeconds: 3600,
				},
			],
		});

		const day = result.find((d) => d.date === '2026-04-15');
		const survivingForIssue = day?.suggestions.filter(
			(s) => s.issueKey === 'PROJ-1',
		);
		expect(survivingForIssue?.length ?? 0).toBe(0);
	});
});

describe('mergeSuggestions: backdated worklogs do not count toward day totals', () => {
	it('excludes backdated existingWorklogs from loggedSeconds and gapSeconds', () => {
		const result = mergeSuggestions({
			weekStart: '2026-04-13',
			jiraSuggestions: [],
			gitlabSuggestions: [],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			existingWorklogs: [
				// Regular 4h log on Wed.
				{
					date: '2026-04-15',
					issueKey: 'PROJ-1',
					timeSpentSeconds: 4 * 3600,
				},
				// Backdated 3h log on the SAME day — must NOT inflate loggedSeconds.
				{
					date: '2026-04-15',
					issueKey: 'PROJ-2',
					timeSpentSeconds: 3 * 3600,
					isBackdated: true,
				},
			],
		});

		const wed = result.find((d) => d.date === '2026-04-15');
		expect(wed?.loggedSeconds).toBe(4 * 3600);
		expect(wed?.gapSeconds).toBe(4 * 3600);
	});
});

describe('mergeSuggestions: loggedWorklogs per day', () => {
	it('collects non-backdated worklogs into loggedWorklogs with a total matching loggedSeconds', () => {
		const result = mergeSuggestions({
			weekStart: '2026-04-13',
			jiraSuggestions: [],
			gitlabSuggestions: [],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			existingWorklogs: [
				{
					date: '2026-04-15',
					issueKey: 'PROJ-1',
					issueSummary: 'Build the thing',
					timeSpentSeconds: 4 * 3600,
					worklogId: 'w1',
				},
				{
					date: '2026-04-15',
					issueKey: 'PROJ-2',
					timeSpentSeconds: 2 * 3600,
					worklogId: 'w2',
				},
			],
		});

		const wed = result.find((d) => d.date === '2026-04-15');
		expect(wed?.loggedWorklogs).toHaveLength(2);
		expect(wed?.loggedWorklogs[0]).toMatchObject({
			worklogId: 'w1',
			issueKey: 'PROJ-1',
			issueSummary: 'Build the thing',
			timeSpentSeconds: 4 * 3600,
		});
		const total = (wed?.loggedWorklogs ?? []).reduce(
			(sum, w) => sum + w.timeSpentSeconds,
			0,
		);
		expect(total).toBe(wed?.loggedSeconds);
	});

	it('excludes backdated worklogs from loggedWorklogs', () => {
		const result = mergeSuggestions({
			weekStart: '2026-04-13',
			jiraSuggestions: [],
			gitlabSuggestions: [],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			existingWorklogs: [
				{
					date: '2026-04-15',
					issueKey: 'PROJ-1',
					timeSpentSeconds: 4 * 3600,
					worklogId: 'w1',
				},
				{
					date: '2026-04-15',
					issueKey: 'PROJ-2',
					timeSpentSeconds: 3 * 3600,
					worklogId: 'w2',
					isBackdated: true,
				},
			],
		});

		const wed = result.find((d) => d.date === '2026-04-15');
		expect(wed?.loggedWorklogs).toHaveLength(1);
		expect(wed?.loggedWorklogs[0]?.issueKey).toBe('PROJ-1');
	});

	it('defaults to an empty array on days with no logged worklogs', () => {
		const result = mergeSuggestions({
			weekStart: '2026-04-13',
			jiraSuggestions: [],
			gitlabSuggestions: [],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			existingWorklogs: [],
		});

		expect(result.every((d) => Array.isArray(d.loggedWorklogs))).toBe(true);
		expect(result.every((d) => d.loggedWorklogs.length === 0)).toBe(true);
	});
});

describe('roundingStepSeconds', () => {
	it('returns 60 (one-minute) when rounding is off', () => {
		expect(roundingStepSeconds('off')).toBe(60);
	});

	it('returns 900 (15 minutes) when rounding is 15m', () => {
		expect(roundingStepSeconds('15m')).toBe(900);
	});

	it('returns 1800 (30 minutes) when rounding is 30m', () => {
		expect(roundingStepSeconds('30m')).toBe(1800);
	});
});

describe('github suggestions merge', () => {
	it('includes github suggestions and dedups against gitlab by confidence', () => {
		const base = {
			weekStart: '2026-06-15',
			jiraSuggestions: [],
			gitlabSuggestions: [
				{
					id: 'gitlab-PUMA-1-2026-06-16',
					source: 'gitlab' as const,
					issueKey: 'PUMA-1',
					date: '2026-06-16',
					suggestedTimeSpent: '30m',
					suggestedSeconds: 1800,
					confidence: 'low' as const,
					reason: 'gl',
					logged: false,
				},
			],
			githubSuggestions: [
				{
					id: 'github-PUMA-1-2026-06-16',
					source: 'github' as const,
					issueKey: 'PUMA-1',
					date: '2026-06-16',
					suggestedTimeSpent: '1h',
					suggestedSeconds: 3600,
					confidence: 'high' as const,
					reason: 'gh',
					logged: false,
				},
			],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			existingWorklogs: [],
			timeRounding: 'off' as const,
		};
		const days = mergeSuggestions(base as never);
		const all = days.flatMap((d) => d.suggestions);
		const puma1 = all.filter((s) => s.issueKey === 'PUMA-1');
		// Deduped to one, the higher-confidence GitHub one wins.
		expect(puma1).toHaveLength(1);
		expect(puma1[0].source).toBe('github');
	});
});
