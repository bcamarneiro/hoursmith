import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MyWeekPage } from '../MyWeekPage';
import { useDashboardStore } from '../../../stores/useDashboardStore';
import { useConfigStore } from '../../../stores/useConfigStore';
import type { DaySummary, WorklogSuggestion } from '../../../../types/Suggestion';
import { toast } from '../../components/ui/Toast';

vi.mock('../../components/ui/Toast', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

// Mock heavy child components to avoid deep dependency chains
vi.mock('../../components/dashboard/DayCard', () => ({
	DayCard: ({ day }: { day: DaySummary }) => (
		<div data-testid={`day-card-${day.date}`}>{day.date}</div>
	),
}));

vi.mock('../../components/dashboard/WeeklyCloseAssistant', () => ({
	WeeklyCloseAssistant: () => <div data-testid="weekly-close" />,
}));

vi.mock('../../components/dashboard/WeekOverview', () => ({
	WeekOverview: () => <div data-testid="week-overview" />,
}));

vi.mock('../../components/dashboard/WeekNavigator', () => ({
	WeekNavigator: ({ onPrev, onNext, onToday }: any) => (
		<div data-testid="week-nav">
			<button onClick={onPrev}>Prev</button>
			<button onClick={onNext}>Next</button>
			<button onClick={onToday}>Today</button>
		</div>
	),
}));

vi.mock('../../components/dashboard/MonthHeatmap', () => ({
	MonthHeatmap: () => <div data-testid="heatmap" />,
}));

vi.mock('../../components/dashboard/SourceStatusBar', () => ({
	SourceStatusBar: () => <div data-testid="source-status" />,
}));

vi.mock('../../components/dashboard/OfflineIndicator', () => ({
	OfflineIndicator: () => null,
}));

vi.mock('../../components/dashboard/FavoritesManager', () => ({
	FavoritesManager: () => null,
}));

vi.mock('../../components/dashboard/TemplatesManager', () => ({
	TemplatesManager: () => null,
}));

vi.mock('../../components/dashboard/KeyboardShortcutsHelp', () => ({
	KeyboardShortcutsHelp: () => null,
}));

vi.mock('../../components/ui/WorklogLoadingStatus', () => ({
	WorklogLoadingStatus: () => <div data-testid="loading-status" />,
}));

// Mock hooks
const mockCopyPreviousWeek = vi.fn();
vi.mock('../../hooks/useCopyPreviousWeek', () => ({
	useCopyPreviousWeek: () => ({
		copyPreviousWeek: mockCopyPreviousWeek,
		isLoading: false,
	}),
}));

vi.mock('../../hooks/useDashboardDataFetcher', () => ({
	useDashboardDataFetcher: () => ({ refetch: vi.fn(), filteredOutEmpty: null }),
}));

const mockCreateMultipleWorklogs = vi.fn();
const mockDeleteWorklog = vi.fn();
vi.mock('../../hooks/useWorklogOperations', () => ({
	useWorklogOperations: () => ({
		createWorklog: vi.fn(),
		createMultipleWorklogs: mockCreateMultipleWorklogs,
		deleteWorklog: mockDeleteWorklog,
		updateWorklog: vi.fn(),
		getWorklog: vi.fn(),
		isLoading: false,
	}),
}));

vi.mock('../../hooks/useAbsenceDays', () => ({
	useAbsenceDays: () => ({ data: [], error: null }),
}));

vi.mock('../../hooks/useMonthHeatmapData', () => ({
	useMonthHeatmapData: () => ({
		data: new Map(),
		isLoading: false,
		month: 0,
		year: 2024,
		backdatedSeconds: 0,
	}),
}));

vi.mock('../../hooks/useComplianceReminder', () => ({
	useComplianceReminder: () => ({
		canRemind: false,
		reminderEnabled: false,
		enableReminder: vi.fn(),
		totalGapHours: 0,
	}),
}));

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
	useKeyboardShortcuts: () => ({
		focusedDayIndex: -1,
		focusedSuggestionIndex: -1,
		showHelp: false,
		setShowHelp: vi.fn(),
	}),
}));

vi.mock('../../analytics', () => ({
	trackEvent: vi.fn(),
}));

vi.mock('../../services/serviceErrors', () => ({
	describeServiceError: () => ({ message: 'Error' }),
}));

describe('MyWeekPage - Log All Suggestions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useDashboardStore.setState({
			daySummaries: [],
			weekWorklogs: [],
			weekGhosts: [],
			isLoadingWorklogs: false,
			worklogsError: null,
		});
		useConfigStore.setState({
			config: {
				jiraHost: 'https://test.atlassian.net',
				email: 'test@example.com',
				apiToken: 'token',
				timeRounding: 'off',
				corsProxy: '',
				jqlFilter: '',
				allowedUsers: [],
				canAddWorklogs: true,
				includeGitlabSuggestions: false,
				includeCalendarSuggestions: false,
				includeRescueTime: false,
				gitlabToken: '',
				gitlabUrl: '',
				calendarApiKey: '',
				calendarId: '',
				rescueTimeKey: '',
				includeCsvProvenance: false,
				includeAbsenceInCsv: false,
			},
		});
	});

	function makeSuggestion(
		id: string,
		issueKey: string,
		date: string,
		logged = false,
	): WorklogSuggestion {
		return {
			id,
			issueKey,
			issueSummary: `Issue ${issueKey}`,
			suggestedTimeSpent: '1h',
			suggestedSeconds: 3600,
			date,
			source: 'previous-week',
			logged,
			confidence: 'high',
			reason: 'Copied from previous week',
		};
	}

	function makeDay(
		date: string,
		suggestions: WorklogSuggestion[] = [],
	): DaySummary {
		return {
			date,
			dayOfWeek: 1,
			isWeekend: false,
			targetSeconds: 28800,
			loggedSeconds: 0,
			gapSeconds: 28800,
			suggestions,
			loggedWorklogs: [],
			absenceKind: undefined,
		};
	}

	it('shows Log All button with count when suggestions exist', () => {
		const s1 = makeSuggestion('1', 'PROJ-1', '2024-01-15');
		const s2 = makeSuggestion('2', 'PROJ-2', '2024-01-16');
		useDashboardStore.setState({
			daySummaries: [
				makeDay('2024-01-15', [s1]),
				makeDay('2024-01-16', [s2]),
			],
		});

		render(<MyWeekPage />);

		const btn = screen.getByRole('button', { name: /Log All \(2\)/i });
		expect(btn).toBeTruthy();
		expect(btn.getAttribute('disabled')).toBeNull();
	});

	it('disables Log All button when no suggestions exist', () => {
		useDashboardStore.setState({
			daySummaries: [makeDay('2024-01-15', [])],
		});

		render(<MyWeekPage />);

		const btn = screen.getByRole('button', { name: /^Log All$/i });
		expect(btn.getAttribute('disabled')).not.toBeNull();
	});

	it('does not count already-logged suggestions', () => {
		const s1 = makeSuggestion('1', 'PROJ-1', '2024-01-15', false);
		const s2 = makeSuggestion('2', 'PROJ-2', '2024-01-15', true);
		useDashboardStore.setState({
			daySummaries: [makeDay('2024-01-15', [s1, s2])],
		});

		render(<MyWeekPage />);

		const btn = screen.getByRole('button', { name: /Log All \(1\)/i });
		expect(btn).toBeTruthy();
	});

	it('calls createMultipleWorklogs with all loggable suggestions', async () => {
		mockCreateMultipleWorklogs.mockResolvedValue({
			success: 2,
			failed: [],
			created: [
				{ issueKey: 'PROJ-1', worklogId: '100' },
				{ issueKey: 'PROJ-2', worklogId: '101' },
			],
		});

		const s1 = makeSuggestion('1', 'PROJ-1', '2024-01-15');
		const s2 = makeSuggestion('2', 'PROJ-2', '2024-01-16');
		useDashboardStore.setState({
			daySummaries: [
				makeDay('2024-01-15', [s1]),
				makeDay('2024-01-16', [s2]),
			],
		});

		render(<MyWeekPage />);

		const btn = screen.getByRole('button', { name: /Log All \(2\)/i });
		fireEvent.click(btn);

		await waitFor(() => {
			expect(mockCreateMultipleWorklogs).toHaveBeenCalledTimes(1);
		});

		const args = mockCreateMultipleWorklogs.mock.calls[0][0];
		expect(args).toHaveLength(2);
		expect(args[0].issueKey).toBe('PROJ-1');
		expect(args[0].timeSpent).toBe('1h');
		expect(args[1].issueKey).toBe('PROJ-2');
	});

	it('marks suggestions as logged after successful batch', async () => {
		mockCreateMultipleWorklogs.mockResolvedValue({
			success: 2,
			failed: [],
			created: [
				{ issueKey: 'PROJ-1', worklogId: '100' },
				{ issueKey: 'PROJ-2', worklogId: '101' },
			],
		});

		const s1 = makeSuggestion('1', 'PROJ-1', '2024-01-15');
		const s2 = makeSuggestion('2', 'PROJ-2', '2024-01-16');
		useDashboardStore.setState({
			daySummaries: [
				makeDay('2024-01-15', [s1]),
				makeDay('2024-01-16', [s2]),
			],
		});

		render(<MyWeekPage />);

		const btn = screen.getByRole('button', { name: /Log All \(2\)/i });
		fireEvent.click(btn);

		await waitFor(() => {
			const state = useDashboardStore.getState();
			const all = state.daySummaries.flatMap((d) => d.suggestions);
			expect(all.filter((s) => s.logged).length).toBe(2);
		});
	});

	it('shows loading state during batch log', async () => {
		let resolvePromise: (value: any) => void;
		const promise = new Promise((resolve) => {
			resolvePromise = resolve;
		});
		mockCreateMultipleWorklogs.mockReturnValue(promise);

		const s1 = makeSuggestion('1', 'PROJ-1', '2024-01-15');
		useDashboardStore.setState({
			daySummaries: [makeDay('2024-01-15', [s1])],
		});

		render(<MyWeekPage />);

		const btn = screen.getByRole('button', { name: /Log All \(1\)/i });
		fireEvent.click(btn);

		await waitFor(() => {
			const loadingBtn = screen.getByRole('button', { name: /Logging.../i });
			expect(loadingBtn).toBeTruthy();
			expect(loadingBtn.getAttribute('disabled')).not.toBeNull();
		});

		resolvePromise!({
			success: 1,
			failed: [],
			created: [{ issueKey: 'PROJ-1', worklogId: '100' }],
		});

		await waitFor(() => {
			// After success, suggestions are marked logged so button reverts to
			// "Log All" (no count) and is disabled because nothing left to log.
			const restoredBtn = screen.getByRole('button', { name: /^Log All$/i });
			expect(restoredBtn).toBeTruthy();
		});
	});

	it('shows error toast on partial failure', async () => {
		mockCreateMultipleWorklogs.mockResolvedValue({
			success: 1,
			failed: ['PROJ-2'],
			created: [{ issueKey: 'PROJ-1', worklogId: '100' }],
		});

		const s1 = makeSuggestion('1', 'PROJ-1', '2024-01-15');
		const s2 = makeSuggestion('2', 'PROJ-2', '2024-01-16');
		useDashboardStore.setState({
			daySummaries: [
				makeDay('2024-01-15', [s1]),
				makeDay('2024-01-16', [s2]),
			],
		});

		render(<MyWeekPage />);

		const btn = screen.getByRole('button', { name: /Log All \(2\)/i });
		fireEvent.click(btn);

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				expect.stringContaining('failed PROJ-2'),
			);
		});
	});

	it('calls deleteWorklog and unmarks suggestions when Undo is clicked', async () => {
		mockCreateMultipleWorklogs.mockResolvedValue({
			success: 2,
			failed: [],
			created: [
				{ issueKey: 'PROJ-1', worklogId: '100' },
				{ issueKey: 'PROJ-2', worklogId: '101' },
			],
		});
		mockDeleteWorklog.mockResolvedValue(undefined);

		const s1 = makeSuggestion('1', 'PROJ-1', '2024-01-15');
		const s2 = makeSuggestion('2', 'PROJ-2', '2024-01-16');
		useDashboardStore.setState({
			daySummaries: [
				makeDay('2024-01-15', [s1]),
				makeDay('2024-01-16', [s2]),
			],
		});

		render(<MyWeekPage />);

		const btn = screen.getByRole('button', { name: /Log All \(2\)/i });
		fireEvent.click(btn);

		await waitFor(() => {
			expect(toast.success).toHaveBeenCalled();
		});

		const successCall = (toast.success as any).mock.calls[0];
		const undoAction = successCall[1]?.action;
		expect(undoAction).toBeTruthy();
		expect(undoAction.label).toBe('Undo');

		// Verify suggestions are marked as logged
		let state = useDashboardStore.getState();
		let all = state.daySummaries.flatMap((d) => d.suggestions);
		expect(all.filter((s) => s.logged).length).toBe(2);

		// Click Undo
		undoAction.onClick();

		await waitFor(() => {
			expect(mockDeleteWorklog).toHaveBeenCalledTimes(2);
			expect(mockDeleteWorklog).toHaveBeenCalledWith('PROJ-1', '100');
			expect(mockDeleteWorklog).toHaveBeenCalledWith('PROJ-2', '101');
		});

		// Verify suggestions are unmarked
		state = useDashboardStore.getState();
		all = state.daySummaries.flatMap((d) => d.suggestions);
		expect(all.filter((s) => s.logged).length).toBe(0);
	});

	it('shows error toast when Undo fails', async () => {
		mockCreateMultipleWorklogs.mockResolvedValue({
			success: 1,
			failed: [],
			created: [{ issueKey: 'PROJ-1', worklogId: '100' }],
		});
		mockDeleteWorklog.mockRejectedValue(new Error('Delete failed'));

		const s1 = makeSuggestion('1', 'PROJ-1', '2024-01-15');
		useDashboardStore.setState({
			daySummaries: [makeDay('2024-01-15', [s1])],
		});

		render(<MyWeekPage />);

		const btn = screen.getByRole('button', { name: /Log All \(1\)/i });
		fireEvent.click(btn);

		await waitFor(() => {
			expect(toast.success).toHaveBeenCalled();
		});

		const successCall = (toast.success as any).mock.calls[0];
		const undoAction = successCall[1]?.action;

		// Click Undo
		undoAction.onClick();

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith('Undo failed');
		});
	});
});
