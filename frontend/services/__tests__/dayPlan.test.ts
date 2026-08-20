import { describe, expect, it } from 'vitest';
import type { DaySummary, WorklogSuggestion } from '../../../types/Suggestion';
import { applyMarkSuggestionLogged } from '../dashboardActions';
import { planDayStarts } from '../dayPlan';

function makeSuggestion(
	overrides: Partial<WorklogSuggestion> = {},
): WorklogSuggestion {
	return {
		id: 'sugg-1',
		source: 'jira-activity',
		issueKey: 'TEST-1',
		date: '2026-03-09',
		suggestedTimeSpent: '1h',
		suggestedSeconds: 3600,
		confidence: 'medium',
		reason: 'Test',
		logged: false,
		...overrides,
	};
}

function makeDay(overrides: Partial<DaySummary> = {}): DaySummary {
	return {
		date: '2026-03-09',
		dayOfWeek: 1,
		isWeekend: false,
		loggedSeconds: 0,
		targetSeconds: 8 * 3600,
		gapSeconds: 8 * 3600,
		suggestions: [],
		loggedWorklogs: [],
		...overrides,
	};
}

describe('planDayStarts', () => {
	it('places two suggestions in sequence, not on the same hour', () => {
		const day = makeDay({
			suggestions: [
				makeSuggestion({ id: 'a' }),
				makeSuggestion({ id: 'b', issueKey: 'TEST-2' }),
			],
		});
		const starts = planDayStarts(day);
		expect(starts.get('a')).not.toBe(starts.get('b'));
	});

	it('skips a suggestion with no issue key — it cannot be logged', () => {
		const day = makeDay({
			suggestions: [makeSuggestion({ id: 'a', issueKey: '' })],
		});
		expect(planDayStarts(day).has('a')).toBe(false);
	});

	it('places around worklogs already logged on the server', () => {
		const day = makeDay({
			suggestions: [makeSuggestion({ id: 'a' })],
			loggedWorklogs: [
				{
					worklogId: '1',
					issueKey: 'TEST-9',
					timeSpentSeconds: 3 * 3600,
					startedAt: '2026-03-09T09:00:00',
				},
			],
		});
		expect(planDayStarts(day).get('a')).not.toBe('2026-03-09T09:00:00');
	});

	// The regression this module exists for. Logging A used to remove it from
	// `suggestions` without recording where it went, so B was then free to take
	// A's slot and the two worklogs overlapped.
	it('keeps a logged suggestion occupying its slot, so the next one moves on', () => {
		const before = makeDay({
			suggestions: [
				makeSuggestion({ id: 'a' }),
				makeSuggestion({ id: 'b', issueKey: 'TEST-2' }),
			],
		});
		const startA = planDayStarts(before).get('a');
		expect(startA).toBeDefined();

		const [after] = applyMarkSuggestionLogged([before], 'a', startA);
		expect(planDayStarts(after).get('b')).not.toBe(startA);
	});

	it('frees the slot again when the log is undone', () => {
		const logged = makeDay({
			suggestions: [
				makeSuggestion({
					id: 'a',
					logged: true,
					loggedStartedAt: '2026-03-09T09:00:00',
				}),
				makeSuggestion({ id: 'b', issueKey: 'TEST-2' }),
			],
		});
		const undone = makeDay({
			suggestions: [
				makeSuggestion({ id: 'a' }),
				makeSuggestion({ id: 'b', issueKey: 'TEST-2' }),
			],
		});
		expect(planDayStarts(logged).get('b')).not.toBe('2026-03-09T09:00:00');
		expect(planDayStarts(undone).get('a')).toBe('2026-03-09T09:00:00');
	});
});
