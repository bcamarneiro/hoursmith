import type { WorklogSuggestion } from '../../types/Suggestion';
import { withLocalOffset } from '../react/utils/date';

/**
 * Parameters accepted by `createWorklog` and `createMultipleWorklogs` in
 * `useWorklogOperations`.
 */
export interface WorklogParams {
	issueKey: string;
	timeSpent: string;
	comment: string;
	started: string;
}

/**
 * Canonical conversion from a `WorklogSuggestion` to a set of worklog-creation
 * parameters.  Extracted from the inline maps in `SuggestionCard.handleLogIt`
 * and `DayCard.handleLogAll` so the logic is testable in isolation and lives
 * in one place.
 *
 * The suggestion's comment field is intentionally empty — the quick "Log it"
 * action logs without a narrative comment; users who want one use "Edit & Log"
 * instead.
 */
export function suggestionToWorklogParams(
	suggestion: WorklogSuggestion,
): WorklogParams {
	return {
		issueKey: suggestion.issueKey,
		timeSpent: suggestion.suggestedTimeSpent,
		comment: '',
		started: withLocalOffset(`${suggestion.date}T09:00`),
	};
}
