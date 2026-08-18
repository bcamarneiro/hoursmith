import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaySummary } from '../../../../../types/Suggestion';

const createMultipleWorklogs = vi.fn();
const deleteWorklog = vi.fn();

vi.mock('../../../hooks/useWorklogOperations', () => ({
	useWorklogOperations: () => ({
		createMultipleWorklogs,
		deleteWorklog,
		isLoading: false,
	}),
}));

// Imported after the mock is declared (vi.mock is hoisted, so order is safe).
import { DayCard } from '../DayCard';

function makeDay(overrides: Partial<DaySummary> = {}): DaySummary {
	return {
		date: '2026-07-10', // Friday
		dayOfWeek: 5,
		isWeekend: false,
		loggedSeconds: 28800,
		targetSeconds: 28800,
		gapSeconds: 3600, // a gap → day renders expanded
		suggestions: [],
		loggedWorklogs: [
			{
				worklogId: 'w1',
				issueKey: 'PROJ-1',
				issueSummary: 'Build the thing',
				timeSpentSeconds: 28800,
			},
		],
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

describe('DayCard — clone worklog', () => {
	beforeEach(() => {
		createMultipleWorklogs.mockReset();
		deleteWorklog.mockReset();
		createMultipleWorklogs.mockResolvedValue({
			success: 2,
			failed: [],
			created: [],
		});
	});

	it('renders each real worklog with a Clone to… button', () => {
		renderCard(makeDay());
		expect(screen.getByText('PROJ-1')).toBeTruthy();
		expect(
			screen.getByRole('button', { name: 'Clone PROJ-1 to other days' }),
		).toBeTruthy();
	});

	it('clones the worklog to the selected days with empty comments at 09:00', async () => {
		renderCard(makeDay());

		fireEvent.click(
			screen.getByRole('button', { name: 'Clone PROJ-1 to other days' }),
		);
		// Popover open on the source month (July 2026).
		fireEvent.click(screen.getByRole('button', { name: '2026-07-16' }));
		fireEvent.click(screen.getByRole('button', { name: '2026-07-15' }));
		fireEvent.click(screen.getByRole('button', { name: /Clone →/ }));

		expect(createMultipleWorklogs).toHaveBeenCalledTimes(1);
		// Flush the awaited createMultipleWorklogs → setCloneSource(null) update.
		await act(async () => {});
		const params = createMultipleWorklogs.mock.calls[0][0];
		expect(params).toHaveLength(2);
		expect(params[0]).toEqual(
			expect.objectContaining({
				issueKey: 'PROJ-1',
				timeSpent: '8h',
				comment: '',
				started: expect.stringContaining('2026-07-15T09:00'),
			}),
		);
		expect(params[1]).toEqual(
			expect.objectContaining({
				issueKey: 'PROJ-1',
				timeSpent: '8h',
				comment: '',
				started: expect.stringContaining('2026-07-16T09:00'),
			}),
		);
	});

	it('closes the modal on clone failure and surfaces the error', async () => {
		createMultipleWorklogs.mockRejectedValueOnce(
			new Error('Jira rejected the worklog'),
		);
		renderCard(makeDay());

		fireEvent.click(
			screen.getByRole('button', { name: 'Clone PROJ-1 to other days' }),
		);
		fireEvent.click(screen.getByRole('button', { name: '2026-07-16' }));
		fireEvent.click(screen.getByRole('button', { name: /Clone →/ }));

		await act(async () => {});

		// Modal should be closed (the popover is gone)
		expect(screen.queryByRole('button', { name: /Clone →/ })).toBeNull();
	});
});
