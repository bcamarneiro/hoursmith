import type { DaySummary } from '../../types/Suggestion';
import { layOutDay } from '../react/utils/dayLayout';

/**
 * Decides what time of day each loggable suggestion should be written at.
 *
 * Time is occupied by two things the day knows about separately: worklogs
 * fetched from the server (`loggedWorklogs`) and suggestions logged during this
 * session, which carry the start they were written with (`loggedStartedAt`).
 * Both have to be treated as busy — counting only the first is what let a
 * freshly logged suggestion's slot be handed straight to the next one.
 *
 * Returns a map of suggestion id -> local `YYYY-MM-DDTHH:mm`. Suggestions
 * without an issue key are absent: they cannot be logged, so they get no slot.
 */
export function planDayStarts(day: DaySummary): Map<string, string> {
	const busy = [
		...day.loggedWorklogs
			.filter((w) => w.startedAt)
			.map((w) => ({
				startedAt: w.startedAt as string,
				seconds: w.timeSpentSeconds,
			})),
		...day.suggestions
			.filter((s) => s.logged && s.loggedStartedAt)
			.map((s) => ({
				startedAt: s.loggedStartedAt as string,
				seconds: s.suggestedSeconds,
			})),
	];

	const placed = layOutDay({
		date: day.date,
		suggestions: day.suggestions
			.filter((s) => !!s.issueKey && !s.logged)
			.map((s) => ({
				id: s.id,
				seconds: s.suggestedSeconds,
				activityAt: s.activityAt,
			})),
		activeHours: day.rescueTime?.activeHours ?? [],
		existing: busy,
	});
	return new Map(placed.map((p) => [p.id, p.startedAt]));
}
