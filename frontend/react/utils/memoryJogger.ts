/**
 * Memory-jog question generator for the dashboard.
 *
 * Given a day's contextual signals (suggestions from various sources, time gaps),
 * produces a short list of questions to help the user recall unlogged work.
 * Questions are deterministic and privacy-safe — no external calls.
 *
 * The component reads these from config; this module is pure logic so it
 * can be unit-tested without React.
 */

import type { DaySummary } from '../../../types/Suggestion';

/** A single memory-jog question with optional context. */
export interface MemoryJogQuestion {
	/** Stable unique identifier for list rendering. */
	id: string;
	/** The question text, e.g. "You have a 2h gap — what filled that time?" */
	question: string;
	/** Optional hint to help the user recall, e.g. "Calendar: 'Design Review'" */
	hint?: string;
}

/**
 * Format seconds as a human-readable duration string.
 * 1800 → "30m", 5400 → "1h 30m", 28800 → "8h".
 */
function formatDuration(seconds: number): string {
	if (seconds <= 0) return '0m';
	const totalMinutes = Math.round(seconds / 60);
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	if (h === 0) return `${m}m`;
	if (m === 0) return `${h}h`;
	return `${h}h ${m}m`;
}

/**
 * Generate memory-jog questions for a single day based on available signals.
 *
 * Returns an empty array when the day is already fully logged (gap === 0)
 * or when no signals are available to jog from.
 */
export function generateMemoryJogQuestions(
	day: DaySummary,
): MemoryJogQuestion[] {
	// Don't jog on fully logged days or weekends.
	if (day.gapSeconds <= 0 || day.isWeekend) return [];

	const questions: MemoryJogQuestion[] = [];

	// 1. Gap-based question — the most universal prompt.
	if (day.gapSeconds > 0) {
		questions.push({
			id: 'gap',
			question: `You have ${formatDuration(day.gapSeconds)} unaccounted for — what filled that time?`,
		});
	}

	// 2. Calendar-based question — if there are calendar suggestions not yet logged.
	const calendarSuggestions = day.suggestions.filter(
		(s) => s.source === 'calendar' && !s.logged,
	);
	if (calendarSuggestions.length > 0) {
		const eventList = calendarSuggestions
			.slice(0, 3)
			.map((s) => s.calendarEventTitle || s.issueSummary || s.issueKey)
			.join(', ');
		questions.push({
			id: 'calendar',
			question: 'Did any of these calendar events involve billable work?',
			hint: eventList,
		});
	}

	// 3. Git-based question — if there are gitlab suggestions not yet logged.
	const gitSuggestions = day.suggestions.filter(
		(s) => s.source === 'gitlab' && !s.logged,
	);
	if (gitSuggestions.length > 0) {
		const issueList = gitSuggestions
			.slice(0, 3)
			.map((s) => s.issueSummary || s.issueKey)
			.join(', ');
		questions.push({
			id: 'git',
			question: 'These commits might need time logged against them:',
			hint: issueList,
		});
	}

	// 4. Jira activity question — if there are jira-activity suggestions not yet logged.
	const jiraSuggestions = day.suggestions.filter(
		(s) => s.source === 'jira-activity' && !s.logged,
	);
	if (jiraSuggestions.length > 0) {
		const issueList = jiraSuggestions
			.slice(0, 3)
			.map((s) => s.issueKey)
			.join(', ');
		questions.push({
			id: 'jira',
			question: 'You touched these issues — was any time spent on them?',
			hint: issueList,
		});
	}

	return questions;
}
