import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaySummary } from '../../../../../types/Suggestion';
import { useDashboardStore } from '../../../../stores/useDashboardStore';
import { RecentActivity } from '../RecentActivity';

function makeSuggestion(overrides: Record<string, unknown> = {}) {
	return {
		id: 'jira-PROJ-1-2026-07-28',
		source: 'jira-activity',
		issueKey: 'PROJ-1',
		issueSummary: 'Fix login bug',
		date: '2026-07-28',
		suggestedTimeSpent: '1h',
		suggestedSeconds: 3600,
		confidence: 'medium' as const,
		reason: '1 status change',
		logged: false,
		...overrides,
	};
}

function makeDay(
	date: string,
	suggestions: DaySummary['suggestions'] = [],
): DaySummary {
	return {
		date,
		dayOfWeek: 2,
		isWeekend: false,
		loggedSeconds: 0,
		targetSeconds: 28800,
		gapSeconds: 28800,
		suggestions,
		loggedWorklogs: [],
	};
}

afterEach(() => {
	act(() => {
		useDashboardStore.setState({ daySummaries: [] });
	});
});

describe('RecentActivity', () => {
	it('renders empty state when no jira-activity suggestions exist', () => {
		act(() => {
			useDashboardStore.setState({ daySummaries: [] });
		});
		render(<RecentActivity isOpen={true} onClose={() => {}} />);
		expect(
			screen.getByText('No recent Jira activity found for this week.'),
		).toBeTruthy();
	});

	it('ignores non-jira-activity suggestions', () => {
		const day = makeDay('2026-07-28', [
			{
				id: 'cal-1',
				source: 'calendar',
				issueKey: 'PROJ-10',
				issueSummary: 'Sprint planning',
				date: '2026-07-28',
				suggestedTimeSpent: '30m',
				suggestedSeconds: 1800,
				confidence: 'low',
				reason: 'Calendar event',
				logged: false,
			},
		]);
		act(() => {
			useDashboardStore.setState({ daySummaries: [day] });
		});
		render(<RecentActivity isOpen={true} onClose={() => {}} />);
		expect(
			screen.getByText('No recent Jira activity found for this week.'),
		).toBeTruthy();
	});

	it('groups jira-activity suggestions by issue key', () => {
		const s1 = makeSuggestion({
			id: 'jira-PROJ-1-2026-07-28',
			issueKey: 'PROJ-1',
			issueSummary: 'Fix login bug',
			date: '2026-07-28',
			reason: '2 status changes, 1 comment',
			suggestedTimeSpent: '1h 30m',
			suggestedSeconds: 5400,
		});
		const s2 = makeSuggestion({
			id: 'jira-PROJ-1-2026-07-29',
			issueKey: 'PROJ-1',
			issueSummary: 'Fix login bug',
			date: '2026-07-29',
			reason: '1 status change',
			suggestedTimeSpent: '1h',
			suggestedSeconds: 3600,
		});
		const s3 = makeSuggestion({
			id: 'jira-PROJ-2-2026-07-28',
			issueKey: 'PROJ-2',
			issueSummary: 'Update docs',
			date: '2026-07-28',
			reason: '1 comment',
			suggestedTimeSpent: '30m',
			suggestedSeconds: 1800,
		});

		const tue = makeDay('2026-07-28', [s1, s3]);
		const wed = makeDay('2026-07-29', [s2]);

		act(() => {
			useDashboardStore.setState({ daySummaries: [tue, wed] });
		});
		render(<RecentActivity isOpen={true} onClose={() => {}} />);

		// Both issue keys should appear
		expect(screen.getByText('PROJ-1')).toBeTruthy();
		expect(screen.getByText('PROJ-2')).toBeTruthy();

		// Each should show its summary
		expect(screen.getByText('Fix login bug')).toBeTruthy();
		expect(screen.getByText('Update docs')).toBeTruthy();

		// PROJ-1 should have two days displayed
		const proj1Item = screen.getByText('PROJ-1').closest('li')!;
		const proj1Days = within(proj1Item).getAllByText(/status change/);
		expect(proj1Days).toHaveLength(2);

		// PROJ-2 should have one day
		const proj2Item = screen.getByText('PROJ-2').closest('li')!;
		const proj2Days = within(proj2Item).getAllByText(/comment/);
		expect(proj2Days).toHaveLength(1);
	});

	it('shows total duration per issue and overall total', () => {
		const s1 = makeSuggestion({
			id: 'jira-PROJ-1-2026-07-28',
			issueKey: 'PROJ-1',
			suggestedSeconds: 5400, // 1h 30m
			suggestedTimeSpent: '1h 30m',
		});

		const day = makeDay('2026-07-28', [s1]);
		act(() => {
			useDashboardStore.setState({ daySummaries: [day] });
		});
		render(<RecentActivity isOpen={true} onClose={() => {}} />);

		// Total per issue: 1h 30m appears in item header and day entry
		const allTimeSpans = screen.getAllByText('1h 30m');
		expect(allTimeSpans.length).toBeGreaterThanOrEqual(2);

		// Footer: "1 issue — estimated total"
		expect(screen.getByText(/1 issue/)).toBeTruthy();
	});

	it('renders day labels in short format', () => {
		const s1 = makeSuggestion({
			id: 'jira-PROJ-1-2026-07-28',
			date: '2026-07-28',
		});
		const day = makeDay('2026-07-28', [s1]);

		act(() => {
			useDashboardStore.setState({ daySummaries: [day] });
		});
		render(<RecentActivity isOpen={true} onClose={() => {}} />);

		// Day label should include the weekday short form (Tue for 2026-07-28)
		expect(screen.getByText(/Tue/)).toBeTruthy();
	});

	it('contains a role="list" for accessibility', () => {
		const s1 = makeSuggestion();
		const day = makeDay('2026-07-28', [s1]);
		act(() => {
			useDashboardStore.setState({ daySummaries: [day] });
		});
		render(<RecentActivity isOpen={true} onClose={() => {}} />);

		expect(screen.getByRole('list')).toBeTruthy();
	});
});
