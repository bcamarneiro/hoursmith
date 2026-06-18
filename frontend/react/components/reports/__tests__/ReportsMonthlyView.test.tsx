import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ReportsMonthlyView } from '../ReportsMonthlyView';

const noop = () => {};

const baseProps = {
	filteredVisibleEntries: [],
	selectedUser: '',
	isValidUser: false,
	selectedEntry: undefined,
	userEmails: {},
	issueSummaries: {},
	monthlyAbsenceDaysByUser: undefined,
	currentYear: 2025,
	currentMonth: 4,
	isLoading: false,
	hasData: true,
	hasNoData: true,
	hasNoFilteredMonthlyResults: false,
	monthlyWorklogProgress: null,
	monthlySummary: null,
	errorMessage: undefined,
	onUserChange: noop,
	onDownloadUser: noop,
};

describe('ReportsMonthlyView', () => {
	it('renders empty-state for no monthly data without throwing', () => {
		render(
			<MemoryRouter>
				<ReportsMonthlyView {...baseProps} />
			</MemoryRouter>,
		);
		expect(screen.getByText('No worklogs found')).toBeTruthy();
	});

	it('renders the error block when errorMessage is provided', () => {
		render(
			<MemoryRouter>
				<ReportsMonthlyView
					{...baseProps}
					errorMessage="Jira host not configured"
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText('Unable to load timesheets')).toBeTruthy();
	});

	it('maps a 401 error to a credentials message via the mapper (ADA-475)', () => {
		render(
			<MemoryRouter>
				<ReportsMonthlyView
					{...baseProps}
					errorMessage="Jira search unauthorized (HTTP 401)"
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText(/api token/i)).toBeTruthy();
	});

	it('renders a "Try again" button that re-triggers the fetch (ADA-476)', () => {
		const onRetry = vi.fn();
		render(
			<MemoryRouter>
				<ReportsMonthlyView
					{...baseProps}
					errorMessage="Jira search unauthorized (HTTP 401)"
					onRetry={onRetry}
				/>
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByRole('button', { name: /try again/i }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('omits "Try again" for the not-configured error (only a Settings nudge)', () => {
		render(
			<MemoryRouter>
				<ReportsMonthlyView
					{...baseProps}
					errorMessage="Jira host not configured"
					onRetry={() => {}}
				/>
			</MemoryRouter>,
		);
		expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
	});
});
