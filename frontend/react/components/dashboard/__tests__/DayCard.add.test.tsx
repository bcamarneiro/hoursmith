import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	DaySummary,
	WorklogSuggestion,
} from '../../../../../types/Suggestion';

const createWorklog = vi.fn();

vi.mock('../../../hooks/useWorklogOperations', () => ({
	useWorklogOperations: () => ({
		createWorklog,
		createMultipleWorklogs: vi.fn(),
		deleteWorklog: vi.fn(),
		updateWorklog: vi.fn(),
		getWorklog: vi.fn(),
		isLoading: false,
	}),
}));

// Imported after the mock is declared (vi.mock is hoisted, so order is safe).
import { DayCard } from '../DayCard';

// 2026-07-08 is a Wednesday with a 2h gap and no suggestions — the exact
// dead-end scenario ADA-433 describes (fresh user, nothing to copy).
function makeDay(overrides: Partial<DaySummary> = {}): DaySummary {
	return {
		date: '2026-07-08',
		dayOfWeek: 3,
		isWeekend: false,
		loggedSeconds: 21600,
		targetSeconds: 28800,
		gapSeconds: 7200,
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

describe('DayCard — add worklog (ADA-433)', () => {
	beforeEach(() => {
		createWorklog.mockReset();
		createWorklog.mockResolvedValue({});
	});

	it('offers an Add worklog affordance even with no suggestions', () => {
		renderCard(makeDay());
		// Header button plus the inline empty-state button — both reachable.
		expect(
			screen.getAllByRole('button', {
				name: 'Add a worklog for Wednesday',
			}).length,
		).toBeGreaterThan(0);
	});

	it('opens the worklog form prefilled with the gap duration and creates a worklog', async () => {
		renderCard(makeDay());

		fireEvent.click(
			screen.getAllByRole('button', {
				name: 'Add a worklog for Wednesday',
			})[0],
		);

		// Form opens with the remaining 2h gap prefilled as the suggested time.
		const timeInput = screen.getByPlaceholderText(
			'e.g., 1h 30m',
		) as HTMLInputElement;
		expect(timeInput.value).toBe('2h');

		// Fill in the issue key and submit.
		const issueInput = screen.getByPlaceholderText(
			'e.g., PROJ-123 or search Jira',
		) as HTMLInputElement;
		fireEvent.change(issueInput, { target: { value: 'proj-9' } });

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /Create Worklog/ }));
		});

		expect(createWorklog).toHaveBeenCalledTimes(1);
		const arg = createWorklog.mock.calls[0][0];
		expect(arg).toEqual(
			expect.objectContaining({
				issueKey: 'PROJ-9',
				timeSpent: '2h',
				comment: '',
				started: expect.stringContaining('2026-07-08T09:00'),
			}),
		);
	});
});

describe('DayCard — recent activity fill (ADA-656)', () => {
	const loggedSuggestion: WorklogSuggestion = {
		id: 'sug-1',
		source: 'jira-activity',
		issueKey: 'TEAM-42',
		issueSummary: 'Set up CI pipeline',
		date: '2026-07-08',
		suggestedTimeSpent: '1h 30m',
		suggestedSeconds: 5400,
		confidence: 'high',
		reason: 'test reason',
		logged: true,
	};

	beforeEach(() => {
		createWorklog.mockReset();
		createWorklog.mockResolvedValue({});
	});

	it('shows recent activity section when day has logged suggestions', () => {
		renderCard(
			makeDay({
				suggestions: [loggedSuggestion],
				gapSeconds: 7200,
			}),
		);

		fireEvent.click(
			screen.getAllByRole('button', {
				name: 'Add a worklog for Wednesday',
			})[0],
		);

		expect(screen.getByText('Recent Activity')).toBeDefined();
		expect(screen.getByText('TEAM-42')).toBeDefined();
		expect(screen.getByText('Set up CI pipeline')).toBeDefined();
		expect(screen.getByText('1h 30m')).toBeDefined();
	});

	it('does not show recent activity section when no logged suggestions', () => {
		renderCard(
			makeDay({
				suggestions: [],
				gapSeconds: 7200,
			}),
		);

		fireEvent.click(
			screen.getAllByRole('button', {
				name: 'Add a worklog for Wednesday',
			})[0],
		);

		expect(screen.queryByText('Recent Activity')).toBeNull();
	});

	it('fills form fields when a recent activity item is clicked', () => {
		renderCard(
			makeDay({
				suggestions: [loggedSuggestion],
				gapSeconds: 7200,
			}),
		);

		fireEvent.click(
			screen.getAllByRole('button', {
				name: 'Add a worklog for Wednesday',
			})[0],
		);

		// Click the recent activity item to fill the form.
		const fillButton = screen.getByRole('button', {
			name: 'Fill form with TEAM-42, 1h 30m',
		});
		fireEvent.click(fillButton);

		// The issue key input should now contain TEAM-42 (mapped to uppercase).
		const issueInput = screen.getByPlaceholderText(
			'e.g., PROJ-123 or search Jira',
		) as HTMLInputElement;
		expect(issueInput.value).toBe('TEAM-42');

		// The time spent input should contain 1h 30m.
		const timeInput = screen.getByPlaceholderText(
			'e.g., 1h 30m',
		) as HTMLInputElement;
		expect(timeInput.value).toBe('1h 30m');
	});
});
