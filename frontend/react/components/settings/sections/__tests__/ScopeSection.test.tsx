// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ScopeSection } from '../ScopeSection';

function renderScope(
	overrides: Partial<React.ComponentProps<typeof ScopeSection>> = {},
) {
	const props: React.ComponentProps<typeof ScopeSection> = {
		jqlFilter: '',
		allowedUsers: '',
		allowedUserSuggestions: [],
		handleChange: vi.fn(),
		onAllowedUsersChange: vi.fn(),
		jqlFilterId: 'jql',
		allowedUsersId: 'au',
		expectedDailyHours: 8,
		expectedHoursByUser: {},
		onExpectedDailyHoursChange: vi.fn(),
		onExpectedHoursOverrideChange: vi.fn(),
		expectedDailyHoursId: 'edh',
		weeklyDeadlineWeekday: 5,
		weeklyDeadlineTime: '18:00',
		onWeeklyDeadlineWeekdayChange: vi.fn(),
		onWeeklyDeadlineTimeChange: vi.fn(),
		weeklyDeadlineWeekdayId: 'dwd',
		weeklyDeadlineTimeId: 'dwt',
		monthlyDeadlineDay: 3,
		monthlyDeadlineTime: '18:00',
		onMonthlyDeadlineDayChange: vi.fn(),
		onMonthlyDeadlineTimeChange: vi.fn(),
		monthlyDeadlineDayId: 'mdd',
		monthlyDeadlineTimeId: 'mdt',
		...overrides,
	};
	render(<ScopeSection {...props} />);
	return props;
}

describe('ScopeSection', () => {
	it('renders the JQL filter input bound to the prop value', () => {
		renderScope({ jqlFilter: 'project = X' });
		expect(screen.getByLabelText(/JQL Filter/)).toHaveValue('project = X');
	});

	it('renders the chip editor with the prop value', () => {
		renderScope({ allowedUsers: 'alice@example.com' });
		expect(screen.getByText(/Team Members/)).toBeInTheDocument();
	});

	it('binds the team-wide expected hours input', () => {
		const onExpectedDailyHoursChange = vi.fn();
		renderScope({ expectedDailyHours: 6, onExpectedDailyHoursChange });
		const input = screen.getByLabelText(/Expected hours per day/);
		expect(input).toHaveValue(6);
		fireEvent.change(input, { target: { value: '7.5' } });
		expect(onExpectedDailyHoursChange).toHaveBeenCalledWith(7.5);
	});

	it('falls back to 8h when the team-wide input is cleared', () => {
		const onExpectedDailyHoursChange = vi.fn();
		renderScope({ onExpectedDailyHoursChange });
		fireEvent.change(screen.getByLabelText(/Expected hours per day/), {
			target: { value: '' },
		});
		expect(onExpectedDailyHoursChange).toHaveBeenCalledWith(8);
	});

	it('shows a per-person override row per configured member', () => {
		const onExpectedHoursOverrideChange = vi.fn();
		renderScope({
			allowedUsers: 'alice@example.com, bob@example.com',
			expectedHoursByUser: { 'alice@example.com': 6 },
			onExpectedHoursOverrideChange,
		});
		const alice = screen.getByLabelText(
			/Expected hours per day for alice@example.com/,
		);
		expect(alice).toHaveValue(6);

		// Editing bob sets an override; clearing alice removes it (null).
		fireEvent.change(
			screen.getByLabelText(/Expected hours per day for bob@example.com/),
			{ target: { value: '4' } },
		);
		expect(onExpectedHoursOverrideChange).toHaveBeenCalledWith(
			'bob@example.com',
			4,
		);
		fireEvent.change(alice, { target: { value: '' } });
		expect(onExpectedHoursOverrideChange).toHaveBeenCalledWith(
			'alice@example.com',
			null,
		);
	});

	it('hides per-person overrides when no members are configured', () => {
		renderScope({ allowedUsers: '' });
		expect(screen.queryByText(/Per-person overrides/)).not.toBeInTheDocument();
	});

	it('binds the weekly-deadline weekday + time controls (ADA-387)', () => {
		const onWeeklyDeadlineWeekdayChange = vi.fn();
		const onWeeklyDeadlineTimeChange = vi.fn();
		renderScope({
			weeklyDeadlineWeekday: 5,
			weeklyDeadlineTime: '18:00',
			onWeeklyDeadlineWeekdayChange,
			onWeeklyDeadlineTimeChange,
		});

		const day = screen.getByLabelText(/Weekly deadline day/);
		expect(day).toHaveValue('5');
		fireEvent.change(day, { target: { value: '3' } });
		expect(onWeeklyDeadlineWeekdayChange).toHaveBeenCalledWith(3);

		const time = screen.getByLabelText(/Weekly deadline time/);
		expect(time).toHaveValue('18:00');
		fireEvent.change(time, { target: { value: '17:30' } });
		expect(onWeeklyDeadlineTimeChange).toHaveBeenCalledWith('17:30');
	});

	it('binds the monthly-deadline working-day + time controls (ADA-549)', () => {
		const onMonthlyDeadlineDayChange = vi.fn();
		const onMonthlyDeadlineTimeChange = vi.fn();
		renderScope({
			monthlyDeadlineDay: 3,
			monthlyDeadlineTime: '18:00',
			onMonthlyDeadlineDayChange,
			onMonthlyDeadlineTimeChange,
		});

		const day = screen.getByLabelText(/Monthly deadline working day/);
		expect(day).toHaveValue('3');
		fireEvent.change(day, { target: { value: '5' } });
		expect(onMonthlyDeadlineDayChange).toHaveBeenCalledWith(5);

		const time = screen.getByLabelText(/Monthly deadline time/);
		expect(time).toHaveValue('18:00');
		fireEvent.change(time, { target: { value: '12:00' } });
		expect(onMonthlyDeadlineTimeChange).toHaveBeenCalledWith('12:00');
	});
});
