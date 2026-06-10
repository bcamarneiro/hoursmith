import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaySummary } from '../../../../../types/Suggestion';
import { useDashboardStore } from '../../../../stores/useDashboardStore';
import { WeekOverview } from '../WeekOverview';

function makeDay(date: string, dayOfWeek: number): DaySummary {
	return {
		date,
		dayOfWeek,
		isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
		loggedSeconds: 3600,
		targetSeconds: 28800,
		gapSeconds: 25200,
		suggestions: [],
		loggedWorklogs: [],
	};
}

const baseDay = makeDay('2025-10-15', 3); // Wed

afterEach(() => {
	act(() => {
		useDashboardStore.setState({ weekGhosts: [] });
	});
});

describe('WeekOverview ghost rendering', () => {
	it('does not mention reconciliation when there are no ghosts', () => {
		act(() => {
			useDashboardStore.setState({ weekGhosts: [] });
		});
		render(<WeekOverview days={[baseDay]} />);
		const li = screen
			.getAllByRole('listitem')
			.find((el) => el.getAttribute('aria-label')?.includes('2025-10-15'));
		expect(li).toBeTruthy();
		expect(li?.getAttribute('aria-label')).not.toMatch(/reconciled later/);
	});

	it('appends "N reconciled later" to aria-label when day has ghosts', () => {
		act(() => {
			useDashboardStore.setState({
				weekGhosts: [
					{
						date: '2025-10-15',
						intendedFor: '2025-10-15',
						loggedOn: '2025-11-05',
						daysLate: 21,
						issueKey: 'PROJ-1',
						issueSummary: 'Test',
						timeSpentSeconds: 3600,
					},
					{
						date: '2025-10-15',
						intendedFor: '2025-10-15',
						loggedOn: '2025-11-06',
						daysLate: 22,
						issueKey: 'PROJ-2',
						timeSpentSeconds: 1800,
					},
				],
			});
		});
		render(<WeekOverview days={[baseDay]} />);
		const li = screen
			.getAllByRole('listitem')
			.find((el) => el.getAttribute('aria-label')?.includes('2025-10-15'));
		expect(li).toBeTruthy();
		expect(li?.getAttribute('aria-label')).toMatch(/2 reconciled later/);
	});
});
