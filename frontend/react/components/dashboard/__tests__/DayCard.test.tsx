import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
	DaySummary,
	WorklogSuggestion,
} from '../../../../../types/Suggestion';
import { DayCard } from '../DayCard';

// 2025-10-15 is a Wednesday and not "today" — so a complete day collapses by
// default (today stays expanded, which we don't want to assert against here).
function makeDay(overrides: Partial<DaySummary> = {}): DaySummary {
	return {
		date: '2025-10-15',
		dayOfWeek: 3,
		isWeekend: false,
		loggedSeconds: 28800,
		targetSeconds: 28800,
		gapSeconds: 0,
		suggestions: [],
		loggedWorklogs: [],
		...overrides,
	};
}

function renderCard(day: DaySummary) {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<DayCard day={day} />
		</QueryClientProvider>,
	);
}

describe('DayCard — closed-day collapse', () => {
	it('renders a complete weekday collapsed with a Closed chip + expand toggle', () => {
		renderCard(makeDay({ gapSeconds: 0 }));
		expect(screen.getByText('✓ Closed')).toBeTruthy();
		const toggle = screen.getByRole('button', { name: /Expand Wednesday/ });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
	});

	it('expands a closed day when the toggle is clicked', () => {
		renderCard(makeDay({ gapSeconds: 0 }));
		fireEvent.click(screen.getByRole('button', { name: /Expand Wednesday/ }));
		const toggle = screen.getByRole('button', { name: /Collapse Wednesday/ });
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
	});

	it('renders a day with a gap expanded and without a collapse toggle', () => {
		renderCard(makeDay({ gapSeconds: 7200, loggedSeconds: 21600 }));
		expect(screen.queryByText('✓ Closed')).toBeNull();
		expect(
			screen.queryByRole('button', {
				name: /Expand Wednesday|Collapse Wednesday/,
			}),
		).toBeNull();
	});
});

describe('DayCard — suggestion list semantics (RecentActivity surface)', () => {
	const suggestion = (
		id: string,
		overrides: Partial<WorklogSuggestion> = {},
	): WorklogSuggestion => ({
		id,
		source: 'jira-activity',
		issueKey: 'PROJ-123',
		issueSummary: 'Fix the login flow',
		date: '2025-10-15',
		suggestedTimeSpent: '1h',
		suggestedSeconds: 3600,
		confidence: 'high',
		reason: 'Commented on PROJ-123',
		logged: false,
		...overrides,
	});

	it('labels the suggestions container as a list for screen readers', () => {
		renderCard(
			makeDay({
				gapSeconds: 7200,
				loggedSeconds: 21600,
				suggestions: [suggestion('a'), suggestion('b')],
			}),
		);
		const list = screen.getByRole('list', { name: 'Suggestions' });
		expect(list.querySelectorAll('li')).toHaveLength(2);
	});

	it('renders logged suggestions in their own labelled list', () => {
		renderCard(
			makeDay({
				gapSeconds: 7200,
				loggedSeconds: 21600,
				suggestions: [suggestion('a', { logged: true })],
			}),
		);
		expect(
			screen.getByRole('list', { name: 'Logged suggestions' }),
		).toBeTruthy();
	});
});
