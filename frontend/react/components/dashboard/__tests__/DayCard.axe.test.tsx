import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import type { DaySummary } from '../../../../../types/Suggestion';

const getWorklog = vi.fn();

vi.mock('../../../hooks/useWorklogOperations', () => ({
	useWorklogOperations: () => ({
		createWorklog: vi.fn(),
		createMultipleWorklogs: vi.fn(),
		deleteWorklog: vi.fn(),
		updateWorklog: vi.fn(),
		getWorklog,
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
		loggedSeconds: 21600,
		targetSeconds: 28800,
		gapSeconds: 7200, // a gap → day renders expanded
		suggestions: [],
		loggedWorklogs: [
			{
				worklogId: 'w1',
				issueKey: 'PROJ-1',
				issueSummary: 'Build the thing',
				timeSpentSeconds: 21600,
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

async function scanForViolations(root: HTMLElement | typeof document.body) {
	const results = await axe.run(root, {
		// Colour contrast can't be resolved in a DOM-only test environment;
		// it is covered by the token/AA contrast fixes in the module CSS.
		rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
	});
	return results.violations.map((v) => v.id);
}

describe('DayCard — axe scan', () => {
	it('passes axe for the collapsed day card', async () => {
		const { container } = renderCard(
			makeDay({ gapSeconds: 0, loggedSeconds: 28800 }),
		);
		expect(await scanForViolations(container)).toEqual([]);
	});

	it('passes axe for the expanded day card with a logged worklog', async () => {
		const { container } = renderCard(makeDay());
		expect(await scanForViolations(container)).toEqual([]);
	});

	it('passes axe for the edit-worklog modal when open (portaled to body)', async () => {
		getWorklog.mockResolvedValue({
			timeSpent: '6h',
			comment: 'Fixed the login flow',
			started: '2026-07-10T09:00:00.000+0000',
		});

		renderCard(makeDay());

		fireEvent.click(
			screen.getByRole('button', {
				name: 'Edit the time logged on PROJ-1',
			}),
		);

		// handleEditOpen is async — wait for the dialog to appear.
		await waitFor(() => {
			expect(
				screen.getByRole('dialog', { name: 'Edit worklog' }),
			).toBeTruthy();
		});

		// The dialog is portaled outside the DayCard container, so scan the
		// full document body to catch it.
		expect(await scanForViolations(document.body)).toEqual([]);
	});
});
