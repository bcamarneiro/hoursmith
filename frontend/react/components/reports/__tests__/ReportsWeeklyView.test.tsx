import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { TeamMemberSummary } from '../../../../services/teamService';
import { ReportsWeeklyView } from '../ReportsWeeklyView';

const noop = () => {};

const baseProps = {
	teamMembers: [],
	sortedMembers: [],
	weekStart: '2025-05-05',
	weekLoading: false,
	weekFetching: false,
	teamError: null,
	teamLoadingProgress: null,
	sortField: 'name' as const,
	sortDirection: 'asc' as const,
	onSort: noop,
	managerMode: false,
	trendWeeks: 6,
	setTrendWeeks: noop,
	trendModel: undefined,
	trendsLoading: false,
	trendsError: undefined,
	hasNoFilteredWeeklyResults: false,
	weeklySummary: null,
	onMemberClick: noop,
};

describe('ReportsWeeklyView', () => {
	it('renders the empty-team state without throwing', () => {
		render(
			<MemoryRouter>
				<ReportsWeeklyView {...baseProps} />
			</MemoryRouter>,
		);
		expect(screen.getByText('No team data found')).toBeTruthy();
	});

	it('shows the worked-on-PTO badge for a member with workedOnPtoDates', () => {
		const member: TeamMemberSummary = {
			email: 'alice@example.com',
			displayName: 'Alice',
			dailyHours: new Map([['2025-05-07', 4]]),
			totalSeconds: 4 * 3600,
			targetSeconds: 4 * 3600,
			gapSeconds: 0,
			workedOnPtoDates: ['2025-05-07'],
		};
		render(
			<MemoryRouter>
				<ReportsWeeklyView
					{...baseProps}
					teamMembers={[member]}
					sortedMembers={[member]}
				/>
			</MemoryRouter>,
		);
		const badge = screen.getByLabelText(/Worked on time off: 2025-05-07/);
		expect(badge).toBeTruthy();
	});

	it('does NOT show the worked-on-PTO badge when the member has no conflict', () => {
		const member: TeamMemberSummary = {
			email: 'bob@example.com',
			displayName: 'Bob',
			dailyHours: new Map([['2025-05-07', 8]]),
			totalSeconds: 8 * 3600,
			targetSeconds: 8 * 3600,
			gapSeconds: 0,
		};
		render(
			<MemoryRouter>
				<ReportsWeeklyView
					{...baseProps}
					teamMembers={[member]}
					sortedMembers={[member]}
				/>
			</MemoryRouter>,
		);
		expect(screen.queryByLabelText(/Worked on time off/)).toBeNull();
	});

	it('shows the connect-Jira guard when notConfigured, not the empty-team state', () => {
		render(
			<MemoryRouter>
				<ReportsWeeklyView {...baseProps} notConfigured />
			</MemoryRouter>,
		);
		expect(screen.getByText('Connect Jira to see reports')).toBeTruthy();
		expect(screen.getByText('Go to Settings')).toBeTruthy();
		expect(screen.queryByText('No team data found')).toBeNull();
	});

	it('renders the team error block when teamError is provided', () => {
		render(
			<MemoryRouter>
				<ReportsWeeklyView
					{...baseProps}
					teamError={new Error('Permission denied')}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText('Unable to load team data')).toBeTruthy();
		expect(screen.getByText('Permission denied')).toBeTruthy();
	});
});
