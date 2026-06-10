import { beforeEach, describe, expect, it } from 'vitest';
import type { DaySummary, WorklogSuggestion } from '../../../types/Suggestion';
import { useConfigStore } from '../useConfigStore';
import { useDashboardStore } from '../useDashboardStore';

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

function makeDay(suggestions: WorklogSuggestion[]): DaySummary {
	return {
		date: '2026-03-09',
		dayOfWeek: 1,
		isWeekend: false,
		loggedSeconds: 0,
		targetSeconds: 8 * 3600,
		gapSeconds: 8 * 3600,
		suggestions,
		loggedWorklogs: [],
	};
}

function setRounding(value: 'off' | '15m' | '30m') {
	useConfigStore.setState({
		config: {
			...useConfigStore.getState().config,
			timeRounding: value,
		},
	});
}

describe('useDashboardStore.adjustSuggestionTime', () => {
	beforeEach(() => {
		useDashboardStore.setState({
			daySummaries: [makeDay([makeSuggestion({ suggestedSeconds: 3600 })])],
		});
	});

	it('adds delta as-is (no 15-min snap) when rounding is off', () => {
		setRounding('off');
		useDashboardStore.getState().adjustSuggestionTime('sugg-1', 60);
		const updated = useDashboardStore.getState().daySummaries[0].suggestions[0];
		expect(updated.suggestedSeconds).toBe(3660);
	});

	it('snaps to nearest 15 min when rounding is 15m', () => {
		setRounding('15m');
		useDashboardStore.getState().adjustSuggestionTime('sugg-1', 60);
		const updated = useDashboardStore.getState().daySummaries[0].suggestions[0];
		// 3600 + 60 = 3660 → snap to nearest 900 → 3600
		expect(updated.suggestedSeconds).toBe(3600);
	});

	it('snaps to nearest 30 min when rounding is 30m', () => {
		setRounding('30m');
		useDashboardStore.getState().adjustSuggestionTime('sugg-1', 60);
		const updated = useDashboardStore.getState().daySummaries[0].suggestions[0];
		// 3600 + 60 = 3660 → snap to nearest 1800 → 3600
		expect(updated.suggestedSeconds).toBe(3600);
	});
});
