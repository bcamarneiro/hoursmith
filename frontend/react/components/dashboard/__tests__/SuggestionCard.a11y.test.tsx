import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
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

function renderCard(suggestion: WorklogSuggestion, isFocused?: boolean) {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<ul>
				<SuggestionCard suggestion={suggestion} isFocused={isFocused} />
			</ul>
		</QueryClientProvider>,
	);
}

describe('SuggestionCard — accessibility', () => {
	it('renders the card as a list item with a descriptive accessible name', () => {
		renderCard(makeSuggestion());
		const item = screen.getByRole('listitem');
		expect(item).toHaveAttribute(
			'aria-label',
			'PROJ-123 Fix the login flow, suggested 1h, Jira, confidence high',
		);
	});

	it('gives every action button an accessible name', () => {
		renderCard(makeSuggestion());
		expect(
			screen.getByRole('button', { name: 'Log 1h to PROJ-123' }),
		).toBeTruthy();
		expect(
			screen.getByRole('button', {
				name: 'Edit and log suggestion for PROJ-123',
			}),
		).toBeTruthy();
		expect(
			screen.getByRole('button', { name: 'Dismiss suggestion for PROJ-123' }),
		).toBeTruthy();
		expect(
			screen.getByRole('button', { name: 'Decrease time by 15 minutes' }),
		).toBeTruthy();
		expect(
			screen.getByRole('button', { name: 'Increase time by 15 minutes' }),
		).toBeTruthy();
	});

	it('announces the confidence level with context, not a bare word', () => {
		renderCard(makeSuggestion());
		const badge = screen.getByTitle('Confidence: high');
		expect(badge.textContent).toBe('Confidence high');
	});

	it('moves DOM focus to the card when the keyboard nav focuses it', () => {
		renderCard(makeSuggestion(), true);
		expect(document.activeElement).toBe(screen.getByRole('listitem'));
	});

	it('does not steal focus when it is not the focused card', () => {
		renderCard(makeSuggestion());
		expect(document.activeElement).not.toBe(screen.getByRole('listitem'));
	});

	it('is programmatically focusable only while focused', () => {
		const { rerender } = renderCard(makeSuggestion(), true);
		expect(screen.getByRole('listitem')).toHaveAttribute('tabindex', '-1');
		rerender(
			<QueryClientProvider client={new QueryClient()}>
				<SuggestionCard suggestion={makeSuggestion()} isFocused={false} />
			</QueryClientProvider>,
		);
		expect(screen.getByRole('listitem')).not.toHaveAttribute('tabindex');
	});

	it('marks the logged checkmark as decorative so only the result is read', () => {
		renderCard(makeSuggestion({ logged: true, issueSummary: undefined }));
		const item = screen.getByRole('listitem');
		expect(item).toHaveAttribute('aria-label', '1h logged to PROJ-123');
		const checkmark = item.querySelector('span[aria-hidden="true"]');
		expect(checkmark).toBeTruthy();
		expect(screen.getByText(/logged to PROJ-123/)).toBeTruthy();
	});

	it('describes an unmapped calendar event card', () => {
		renderCard(
			makeSuggestion({
				source: 'calendar',
				issueKey: '',
				calendarEventTitle: 'Team sync',
				suggestedTimeSpent: '30m',
				suggestedSeconds: 1800,
			}),
		);
		const item = screen.getByRole('listitem');
		expect(item).toHaveAttribute(
			'aria-label',
			'Team sync, unmapped calendar event, 30m',
		);
	});

	it('labels the Jira issue key input when the mapping row is open', () => {
		renderCard(
			makeSuggestion({
				source: 'calendar',
				issueKey: '',
				calendarEventTitle: 'Team sync',
				suggestedTimeSpent: '30m',
				suggestedSeconds: 1800,
			}),
		);
		fireEvent.click(
			screen.getByRole('button', { name: 'Map Team sync to a Jira issue' }),
		);
		expect(screen.getByLabelText('Jira issue key')).toBeTruthy();
	});
});
