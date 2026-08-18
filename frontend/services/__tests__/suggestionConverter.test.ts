/**
 * Tests for `suggestionToWorklogParams` — the canonical conversion from
 * `WorklogSuggestion` to worklog-creation params.  Mocking `withLocalOffset`
 * keeps the test deterministic regardless of the CI runner's timezone.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorklogSuggestion } from '../../../../types/Suggestion';
import { suggestionToWorklogParams } from '../suggestionConverter';

const mockedWithLocalOffset = vi.fn();

vi.mock('../../react/utils/date', () => ({
	withLocalOffset: (...args: Parameters<typeof mockedWithLocalOffset>) =>
		mockedWithLocalOffset(...args),
}));

function makeSuggestion(
	overrides: Partial<WorklogSuggestion> = {},
): WorklogSuggestion {
	return {
		id: 'sugg-1',
		source: 'jira-activity',
		issueKey: 'TEST-1',
		issueSummary: 'Test issue',
		date: '2026-03-09',
		suggestedTimeSpent: '1h',
		suggestedSeconds: 3600,
		confidence: 'medium',
		reason: 'Test reason',
		logged: false,
		...overrides,
	};
}

describe('suggestionToWorklogParams', () => {
	beforeEach(() => {
		mockedWithLocalOffset.mockReset();
		mockedWithLocalOffset.mockImplementation(
			(dt: string) => `${dt}+0000`,
		);
	});

	it('extracts issueKey from the suggestion', () => {
		const result = suggestionToWorklogParams(makeSuggestion());
		expect(result.issueKey).toBe('TEST-1');
	});

	it('extracts timeSpent from suggestedTimeSpent', () => {
		const result = suggestionToWorklogParams(
			makeSuggestion({ suggestedTimeSpent: '2h 30m' }),
		);
		expect(result.timeSpent).toBe('2h 30m');
	});

	it('sets comment to empty string (quick-log has no narrative)', () => {
		const result = suggestionToWorklogParams(
			makeSuggestion(),
		);
		expect(result.comment).toBe('');
	});

	it('calls withLocalOffset with the date + T09:00 and returns its result', () => {
		mockedWithLocalOffset.mockReturnValue('2026-03-09T09:00:00.000+0100');
		const result = suggestionToWorklogParams(
			makeSuggestion({ date: '2026-03-09' }),
		);
		expect(mockedWithLocalOffset).toHaveBeenCalledWith('2026-03-09T09:00');
		expect(result.started).toBe('2026-03-09T09:00:00.000+0100');
	});

	it('passes through a different date correctly', () => {
		mockedWithLocalOffset.mockReturnValue('2026-07-08T09:00:00.000-0400');
		const result = suggestionToWorklogParams(
			makeSuggestion({ date: '2026-07-08' }),
		);
		expect(mockedWithLocalOffset).toHaveBeenCalledWith('2026-07-08T09:00');
		expect(result.started).toBe('2026-07-08T09:00:00.000-0400');
	});

	it('works with a GitLab source suggestion', () => {
		const result = suggestionToWorklogParams(
			makeSuggestion({
				source: 'gitlab',
				issueKey: 'GL-42',
				suggestedTimeSpent: '45m',
				date: '2026-05-20',
			}),
		);
		expect(result.issueKey).toBe('GL-42');
		expect(result.timeSpent).toBe('45m');
		expect(mockedWithLocalOffset).toHaveBeenCalledWith('2026-05-20T09:00');
	});
});
