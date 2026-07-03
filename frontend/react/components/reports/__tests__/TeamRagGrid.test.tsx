// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { OnTimeStatus } from '../../../utils/onTimeStatus';
import type { OnTimeHistoryMember } from '../../../utils/teamReports';
import { TeamRagGrid } from '../TeamRagGrid';

function member(
	displayName: string,
	currentStatus: OnTimeStatus,
	onTimeWeeks: number,
	statuses: (OnTimeStatus | null)[],
): OnTimeHistoryMember {
	return {
		email: `${displayName.toLowerCase()}@example.com`,
		displayName,
		weeks: statuses.map((status, i) => ({
			weekStart: `2026-03-0${i + 2}`,
			weekEnd: `2026-03-0${i + 8}`,
			status,
		})),
		onTimeWeeks,
		ratedWeeks: statuses.filter((s) => s !== null).length,
		currentStatus,
	};
}

const MEMBERS: OnTimeHistoryMember[] = [
	member('Ana', 'on-time', 2, ['on-time', 'on-time']),
	member('Bob', 'incomplete', 0, ['incomplete', 'incomplete']),
	member('Cara', 'late', 1, ['on-time', 'late']),
];

function renderGrid() {
	return render(
		<MemoryRouter>
			<TeamRagGrid members={MEMBERS} />
		</MemoryRouter>,
	);
}

function memberRowNames(): string[] {
	const body = screen.getAllByRole('rowgroup')[1]; // thead, tbody
	return within(body)
		.getAllByRole('link')
		.map((link) => link.textContent ?? '');
}

describe('TeamRagGrid (ADA-548 sort + filter)', () => {
	it('defaults to worst-record-first order', () => {
		renderGrid();
		// Bob (0 on-time) → Cara (1) → Ana (2).
		expect(memberRowNames()).toEqual(['Bob', 'Cara', 'Ana']);
	});

	it('hides on-time members when "Only needs attention" is checked', () => {
		renderGrid();
		fireEvent.click(screen.getByLabelText('Only needs attention'));
		const names = memberRowNames();
		expect(names).toContain('Bob');
		expect(names).toContain('Cara');
		expect(names).not.toContain('Ana');
	});

	it('sorts alphabetically by name', () => {
		renderGrid();
		fireEvent.change(screen.getByLabelText('Sort'), {
			target: { value: 'name' },
		});
		expect(memberRowNames()).toEqual(['Ana', 'Bob', 'Cara']);
	});

	it('sorts by current status severity (most urgent first)', () => {
		renderGrid();
		fireEvent.change(screen.getByLabelText('Sort'), {
			target: { value: 'status' },
		});
		// incomplete(Bob) → late(Cara) → on-time(Ana).
		expect(memberRowNames()).toEqual(['Bob', 'Cara', 'Ana']);
	});

	it('shows an all-clear message when the attention filter empties the grid', () => {
		render(
			<MemoryRouter>
				<TeamRagGrid members={[member('Ana', 'on-time', 2, ['on-time'])]} />
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByLabelText('Only needs attention'));
		expect(screen.getByText(/Everyone on the roster is on time/)).toBeVisible();
	});
});
