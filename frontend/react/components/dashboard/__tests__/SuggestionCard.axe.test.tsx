import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { WorklogSuggestion } from '../../../../../types/Suggestion';
import { SuggestionCard } from '../SuggestionCard';

function makeSuggestion(
	overrides: Partial<WorklogSuggestion> = {},
): WorklogSuggestion {
	return {
		id: 's1',
		source: 'jira-activity',
		issueKey: 'PROJ-123',
		issueSummary: 'Fix the login flow',
		date: '2025-10-15',
		suggestedTimeSpent: '1h',
		suggestedSeconds: 3600,
		confidence: 'high',
		reason: 'Commented on PROJ-123',
		logged: false,
		...overrides,
	};
}

// Wraps cards in the same labelled list structure DayCard renders.
function renderSuggestionsList(suggestions: WorklogSuggestion[]) {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<ul aria-label="Suggestions">
				{suggestions.map((s) => (
					<SuggestionCard key={s.id} suggestion={s} />
				))}
			</ul>
		</QueryClientProvider>,
	);
}

async function scanForViolations(container: HTMLElement) {
	const results = await axe.run(container, {
		// Colour contrast can't be resolved in a DOM-only test environment;
		// it is covered by the token/AA contrast fixes in the module CSS.
		rules: { 'color-contrast': { enabled: false } },
	});
	return results.violations.map((v) => v.id);
}

describe('SuggestionCard — axe scan (RecentActivity surface)', () => {
	it('passes axe with a mixed set of suggestion cards', async () => {
		const { container } = renderSuggestionsList([
			makeSuggestion(),
			makeSuggestion({
				id: 's2',
				issueKey: 'PROJ-456',
				issueSummary: undefined,
				confidence: 'medium',
			}),
			makeSuggestion({
				id: 's3',
				source: 'calendar',
				issueKey: '',
				calendarEventTitle: 'Team sync',
				suggestedTimeSpent: '30m',
				suggestedSeconds: 1800,
			}),
			makeSuggestion({ id: 's4', logged: true, issueSummary: undefined }),
		]);
		expect(await scanForViolations(container)).toEqual([]);
	});

	it('passes axe with the mapping row open', async () => {
		const { container } = renderSuggestionsList([
			makeSuggestion({
				source: 'calendar',
				issueKey: '',
				calendarEventTitle: 'Team sync',
				suggestedTimeSpent: '30m',
				suggestedSeconds: 1800,
			}),
		]);
		fireEvent.click(
			screen.getByRole('button', { name: 'Map Team sync to a Jira issue' }),
		);
		expect(await scanForViolations(container)).toEqual([]);
	});

	it('passes axe with the edit-worklog dialog open (portaled, not nested in the list)', async () => {
		const { container } = renderSuggestionsList([makeSuggestion()]);
		fireEvent.click(
			screen.getByRole('button', { name: 'Edit and log suggestion for PROJ-123' }),
		);
		// The dialog is portaled to <body>, so axe scans it from there.
		const dialog = screen.getByRole('dialog', { name: 'Log Worklog' });
		expect(dialog.hasAttribute('open')).toBe(true);
		// The dialog is NOT a child of the suggestions list (it would break the
		// list semantics otherwise).
		expect(container.querySelector('dialog')).toBeNull();
		expect(await scanForViolations(container)).toEqual([]);
	});
});
