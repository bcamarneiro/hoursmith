import { describe, expect, it } from 'vitest';
import type { DaySummary, WorklogSuggestion } from '../../../types/Suggestion';
import {
	applyAdjustSuggestionTime,
	applyDismissSuggestion,
	applyFillDayGap,
	applyMarkMultipleLogged,
	applyMarkSuggestionLogged,
	applyUnmarkMultipleLogged,
	applyUnmarkSuggestionLogged,
} from '../dashboardActions';

function makeSuggestion(
	overrides: Partial<WorklogSuggestion> = {},
): WorklogSuggestion {
	return {
		id: 'sugg-1',
		source: 'jira-activity',
		issueKey: 'TEST-1',
		issueSummary: 'Test issue',
		date: '2026-03-09',
		suggestedTimeSpent: '1h',
		suggestedSeconds: 3600,
		confidence: 'medium',
		reason: 'Test',
		logged: false,
		...overrides,
	};
}

function makeDay(
	suggestions: WorklogSuggestion[],
	overrides: Partial<DaySummary> = {},
): DaySummary {
	return {
		date: '2026-03-09',
		dayOfWeek: 1,
		isWeekend: false,
		loggedSeconds: 0,
		targetSeconds: 8 * 3600,
		gapSeconds: 8 * 3600,
		suggestions,
		...overrides,
		loggedWorklogs: [],
	};
}

describe('applyMarkSuggestionLogged', () => {
	it('flips logged flag and shifts seconds from gap to logged', () => {
		const days = [makeDay([makeSuggestion({ suggestedSeconds: 3600 })])];
		const out = applyMarkSuggestionLogged(days, 'sugg-1');
		expect(out[0].suggestions[0].logged).toBe(true);
		expect(out[0].loggedSeconds).toBe(3600);
		expect(out[0].gapSeconds).toBe(8 * 3600 - 3600);
	});

	it('never lets gapSeconds drop below zero', () => {
		const days = [
			makeDay([makeSuggestion({ suggestedSeconds: 10 * 3600 })], {
				gapSeconds: 3600,
			}),
		];
		const out = applyMarkSuggestionLogged(days, 'sugg-1');
		expect(out[0].gapSeconds).toBe(0);
	});

	it('is a no-op when suggestion already logged', () => {
		const days = [
			makeDay([makeSuggestion({ logged: true, suggestedSeconds: 3600 })], {
				loggedSeconds: 0,
			}),
		];
		const out = applyMarkSuggestionLogged(days, 'sugg-1');
		expect(out[0].loggedSeconds).toBe(0);
	});
});

describe('applyUnmarkSuggestionLogged', () => {
	it('reverses the mark and restores gap', () => {
		const days = [
			makeDay([makeSuggestion({ logged: true, suggestedSeconds: 3600 })], {
				loggedSeconds: 3600,
				gapSeconds: 8 * 3600 - 3600,
			}),
		];
		const out = applyUnmarkSuggestionLogged(days, 'sugg-1');
		expect(out[0].suggestions[0].logged).toBe(false);
		expect(out[0].loggedSeconds).toBe(0);
		expect(out[0].gapSeconds).toBe(8 * 3600);
	});

	it('clamps loggedSeconds at zero', () => {
		const days = [
			makeDay([makeSuggestion({ logged: true, suggestedSeconds: 7200 })], {
				loggedSeconds: 100,
			}),
		];
		const out = applyUnmarkSuggestionLogged(days, 'sugg-1');
		expect(out[0].loggedSeconds).toBe(0);
	});
});

describe('applyMarkMultipleLogged / applyUnmarkMultipleLogged', () => {
	it('marks multiple suggestions and accumulates their seconds', () => {
		const days = [
			makeDay([
				makeSuggestion({ id: 'a', suggestedSeconds: 1800 }),
				makeSuggestion({ id: 'b', suggestedSeconds: 3600 }),
				makeSuggestion({ id: 'c', suggestedSeconds: 900 }),
			]),
		];
		const out = applyMarkMultipleLogged(days, ['a', 'b']);
		expect(out[0].loggedSeconds).toBe(5400);
		expect(out[0].suggestions[0].logged).toBe(true);
		expect(out[0].suggestions[1].logged).toBe(true);
		expect(out[0].suggestions[2].logged).toBe(false);
	});

	it('unmarks multiple suggestions and restores gap', () => {
		const days = [
			makeDay(
				[
					makeSuggestion({
						id: 'a',
						logged: true,
						suggestedSeconds: 1800,
					}),
					makeSuggestion({
						id: 'b',
						logged: true,
						suggestedSeconds: 3600,
					}),
				],
				{ loggedSeconds: 5400, gapSeconds: 8 * 3600 - 5400 },
			),
		];
		const out = applyUnmarkMultipleLogged(days, ['a', 'b']);
		expect(out[0].loggedSeconds).toBe(0);
		expect(out[0].gapSeconds).toBe(8 * 3600);
	});
});

describe('applyDismissSuggestion', () => {
	it('removes the suggestion and redistributes the gap across remaining active suggestions', () => {
		const days = [
			makeDay(
				[
					makeSuggestion({ id: 'a', suggestedSeconds: 3600 }),
					makeSuggestion({ id: 'b', suggestedSeconds: 3600 }),
				],
				{ gapSeconds: 7200 },
			),
		];
		const out = applyDismissSuggestion(days, 'a', '15m');
		expect(out[0].suggestions.find((s) => s.id === 'a')).toBeUndefined();
		const remaining = out[0].suggestions.find((s) => s.id === 'b');
		expect(remaining?.suggestedSeconds).toBe(7200);
	});

	it('just drops the suggestion when gap is zero', () => {
		const days = [
			makeDay(
				[
					makeSuggestion({ id: 'a', suggestedSeconds: 3600 }),
					makeSuggestion({ id: 'b', suggestedSeconds: 3600 }),
				],
				{ gapSeconds: 0 },
			),
		];
		const out = applyDismissSuggestion(days, 'a', '15m');
		expect(out[0].suggestions.map((s) => s.id)).toEqual(['b']);
	});
});

describe('applyAdjustSuggestionTime', () => {
	it('adds delta directly (60s step) when rounding is off', () => {
		const days = [makeDay([makeSuggestion({ suggestedSeconds: 3600 })])];
		const out = applyAdjustSuggestionTime(days, 'sugg-1', 60, 'off');
		expect(out[0].suggestions[0].suggestedSeconds).toBe(3660);
	});

	it('snaps to nearest 15 min when rounding is 15m', () => {
		const days = [makeDay([makeSuggestion({ suggestedSeconds: 3600 })])];
		const out = applyAdjustSuggestionTime(days, 'sugg-1', 900, '15m');
		expect(out[0].suggestions[0].suggestedSeconds).toBe(4500);
	});

	it('snaps to nearest 30 min when rounding is 30m and never below one step', () => {
		const days = [makeDay([makeSuggestion({ suggestedSeconds: 1800 })])];
		const out = applyAdjustSuggestionTime(days, 'sugg-1', -10_000, '30m');
		expect(out[0].suggestions[0].suggestedSeconds).toBe(1800);
	});
});

describe('applyFillDayGap', () => {
	it('distributes remaining gap proportionally across active suggestions', () => {
		const days = [
			makeDay(
				[
					makeSuggestion({ id: 'a', suggestedSeconds: 1800 }),
					makeSuggestion({ id: 'b', suggestedSeconds: 1800 }),
				],
				{ gapSeconds: 7200 },
			),
		];
		const out = applyFillDayGap(days, '2026-03-09', '15m');
		const total = out[0].suggestions.reduce(
			(sum, s) => sum + s.suggestedSeconds,
			0,
		);
		expect(total).toBe(7200);
	});

	it('leaves logged suggestions untouched', () => {
		const days = [
			makeDay(
				[
					makeSuggestion({
						id: 'a',
						logged: true,
						suggestedSeconds: 1800,
					}),
					makeSuggestion({ id: 'b', suggestedSeconds: 1800 }),
				],
				{ gapSeconds: 3600, loggedSeconds: 1800 },
			),
		];
		const out = applyFillDayGap(days, '2026-03-09', '15m');
		const logged = out[0].suggestions.find((s) => s.id === 'a');
		expect(logged?.suggestedSeconds).toBe(1800);
	});

	it('is a no-op for unrelated dates', () => {
		const days = [
			makeDay([makeSuggestion({ suggestedSeconds: 1800 })], {
				gapSeconds: 3600,
			}),
		];
		const out = applyFillDayGap(days, '2026-12-31', '15m');
		expect(out[0].suggestions[0].suggestedSeconds).toBe(1800);
	});
});
