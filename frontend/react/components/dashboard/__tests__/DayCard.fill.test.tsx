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
		createWorklog: vi.fn(),
		updateWorklog: vi.fn(),
		getWorklog: vi.fn(),
		isLoading: false,
	}),
}));

// Modal uses <dialog>.showModal() which happy-dom doesn't implement, so we wrap
// it in a plain div to keep tests simple while preserving the rendering contract.
vi.mock('../../ui/Modal', () => ({
	Modal: ({
		isOpen,
		title,
		children,
	}: {
		isOpen: boolean;
		title: string;
		children: React.ReactNode;
	}) =>
		isOpen ? (
			<div data-testid="fill-modal" role="dialog" aria-label={title}>
				<h2>{title}</h2>
				{children}
			</div>
		) : null,
}));

// Capture the undo callback fired by toast.success so we can invoke it in tests
// without rendering the ToastContainer (which uses createPortal).
let capturedUndoCallback: (() => void) | null = null;

vi.mock('../../ui/Toast', () => ({
	toast: Object.assign(
		vi.fn(),
		{
			success: vi.fn((_message: string, options?: { action?: { label: string; onClick: () => void } }) => {
				if (options?.action?.onClick) {
					capturedUndoCallback = options.action.onClick;
				}
			}),
			error: vi.fn(),
			info: vi.fn(),
		},
	),
}));

// Imported after the mocks are declared (vi.mock is hoisted, so order is safe).
import { DayCard } from '../DayCard';

function makeDay(overrides: Partial<DaySummary> = {}): DaySummary {
	return {
		date: '2026-07-10', // Friday
		dayOfWeek: 5,
		isWeekend: false,
		loggedSeconds: 21600,
		targetSeconds: 28800,
		gapSeconds: 7200,
		suggestions: [
			{
				id: 's1',
				source: 'jira-activity',
				issueKey: 'PROJ-42',
				issueSummary: 'Feature X implementation',
				date: '2026-07-10',
				suggestedTimeSpent: '4h',
				suggestedSeconds: 14400,
				confidence: 'high',
				reason: 'Active Jira issue',
				logged: false,
			},
			{
				id: 's2',
				source: 'jira-activity',
				issueKey: 'PROJ-99',
				issueSummary: 'Critical bug fix',
				date: '2026-07-10',
				suggestedTimeSpent: '2h',
				suggestedSeconds: 7200,
				confidence: 'medium',
				reason: 'Assigned to user',
				logged: false,
			},
		],
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

describe('DayCard — fill day preview/confirm/undo', () => {
	beforeEach(() => {
		createMultipleWorklogs.mockReset();
		deleteWorklog.mockReset();
		createMultipleWorklogs.mockResolvedValue({
			success: 2,
			failed: [],
			created: [
				{ issueKey: 'PROJ-42', worklogId: 'wl42' },
				{ issueKey: 'PROJ-99', worklogId: 'wl99' },
			],
		});
		capturedUndoCallback = null;
	});

	it('shows a Fill day button when there is a gap with active suggestions', () => {
		renderCard(makeDay());
		expect(
			screen.getByRole('button', { name: 'Fill remaining gap for Friday' }),
		).toBeTruthy();
	});

	it('does not show Fill day when there is no gap', () => {
		renderCard(makeDay({ gapSeconds: 0 }));
		expect(
			screen.queryByRole('button', { name: /Fill remaining gap/ }),
		).toBeNull();
	});

	it('opens a preview modal listing the issue keys, summaries, and time estimates', () => {
		renderCard(makeDay());

		fireEvent.click(
			screen.getByRole('button', { name: 'Fill remaining gap for Friday' }),
		);

		// Scope queries to the modal to avoid matching suggestion cards.
		const modal = screen.getByTestId('fill-modal');
		expect(modal).toBeTruthy();
		expect(modal.textContent).toContain('PROJ-42');
		expect(modal.textContent).toContain('Feature X implementation');
		expect(modal.textContent).toContain('PROJ-99');
		expect(modal.textContent).toContain('Critical bug fix');
	});

	it('calls createMultipleWorklogs with the suggestion params on confirm', async () => {
		renderCard(makeDay());

		fireEvent.click(
			screen.getByRole('button', { name: 'Fill remaining gap for Friday' }),
		);

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Fill' }));
		});

		expect(createMultipleWorklogs).toHaveBeenCalledTimes(1);
		const params = createMultipleWorklogs.mock.calls[0][0];
		expect(params).toHaveLength(2);

		// distributeSuggestionsToFillGap returns suggestions unchanged when
		// the total suggested (6h) already exceeds the gap (2h), so timeSpent
		// stays at the original suggestion values.
		expect(params[0].issueKey).toBe('PROJ-42');
		expect(params[0].timeSpent).toBe('4h');
		expect(params[1].issueKey).toBe('PROJ-99');
		expect(params[1].timeSpent).toBe('2h');

		// Both worklogs start at 09:00 on the day.
		expect(params[0].started).toContain('2026-07-10T09:00');
		expect(params[1].started).toContain('2026-07-10T09:00');
	});

	it('closes the preview modal when Cancel is clicked', () => {
		renderCard(makeDay());

		fireEvent.click(
			screen.getByRole('button', { name: 'Fill remaining gap for Friday' }),
		);
		expect(screen.getByTestId('fill-modal')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByTestId('fill-modal')).toBeNull();
	});

	it('shows a toast with Undo on success and clicking it deletes the created worklogs', async () => {
		renderCard(makeDay());

		fireEvent.click(
			screen.getByRole('button', { name: 'Fill remaining gap for Friday' }),
		);

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Fill' }));
		});

		// The success toast should have captured the undo action.
		expect(capturedUndoCallback).toBeDefined();

		// Invoke the undo callback — it calls deleteWorklog for each created worklog.
		deleteWorklog.mockResolvedValue({});
		await act(async () => {
			capturedUndoCallback!();
		});

		expect(deleteWorklog).toHaveBeenCalledTimes(2);
		expect(deleteWorklog).toHaveBeenCalledWith('PROJ-42', 'wl42');
		expect(deleteWorklog).toHaveBeenCalledWith('PROJ-99', 'wl99');
	});

	it('shows an error toast when some worklogs fail', async () => {
		createMultipleWorklogs.mockResolvedValue({
			success: 1,
			failed: ['PROJ-99'],
			created: [{ issueKey: 'PROJ-42', worklogId: 'wl42' }],
		});

		renderCard(makeDay());

		fireEvent.click(
			screen.getByRole('button', { name: 'Fill remaining gap for Friday' }),
		);

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Fill' }));
		});

		// When some worklogs fail, toast.error is called instead of toast.success.
		// Import the mock — vi.mock is hoisted so Toast module is already replaced.
		const toastModule = await import('../../ui/Toast');
		expect(toastModule.toast.error).toHaveBeenCalled();
	});
});
