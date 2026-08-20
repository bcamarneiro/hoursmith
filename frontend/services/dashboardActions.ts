import type { DaySummary } from '../../types/Suggestion';
import {
	distributeSuggestionsToFillGap,
	roundingStepSeconds,
} from './suggestionMerger';

export type TimeRounding = 'off' | '15m' | '30m';

function formatTimeSpent(seconds: number): string {
	const hours = seconds / 3600;
	if (hours >= 1) {
		const h = Math.floor(hours);
		const remaining = seconds % 3600;
		return remaining > 0 ? `${h}h ${Math.round(remaining / 60)}m` : `${h}h`;
	}
	return `${Math.round(seconds / 60)}m`;
}

/**
 * Marks a single suggestion as logged. Adds its suggestedSeconds to the day's
 * loggedSeconds, subtracts from gapSeconds (clamped at 0), and flips the flag.
 */
export function applyMarkSuggestionLogged(
	daySummaries: DaySummary[],
	suggestionId: string,
	startedAt?: string,
): DaySummary[] {
	return daySummaries.map((day) => {
		const s = day.suggestions.find((s) => s.id === suggestionId);
		const added = s && !s.logged ? s.suggestedSeconds : 0;
		return {
			...day,
			loggedSeconds: day.loggedSeconds + added,
			gapSeconds: Math.max(0, day.gapSeconds - added),
			suggestions: day.suggestions.map((s) =>
				s.id === suggestionId
					? { ...s, logged: true, loggedStartedAt: startedAt }
					: s,
			),
		};
	});
}

/**
 * Reverses a previous mark. Subtracts suggestedSeconds from loggedSeconds
 * (clamped at 0), adds them back to gapSeconds, and clears the flag.
 */
export function applyUnmarkSuggestionLogged(
	daySummaries: DaySummary[],
	suggestionId: string,
): DaySummary[] {
	return daySummaries.map((day) => {
		const s = day.suggestions.find((s) => s.id === suggestionId);
		const removed = s?.logged ? s.suggestedSeconds : 0;
		return {
			...day,
			loggedSeconds: Math.max(0, day.loggedSeconds - removed),
			gapSeconds: day.gapSeconds + removed,
			suggestions: day.suggestions.map((s) =>
				s.id === suggestionId
					? { ...s, logged: false, loggedStartedAt: undefined }
					: s,
			),
		};
	});
}

/** Bulk-mark suggestions matching any of `ids` as logged. */
export function applyMarkMultipleLogged(
	daySummaries: DaySummary[],
	ids: string[],
	startedById?: ReadonlyMap<string, string>,
): DaySummary[] {
	const idSet = new Set(ids);
	return daySummaries.map((day) => {
		let added = 0;
		for (const s of day.suggestions) {
			if (idSet.has(s.id) && !s.logged) added += s.suggestedSeconds;
		}
		return {
			...day,
			loggedSeconds: day.loggedSeconds + added,
			gapSeconds: Math.max(0, day.gapSeconds - added),
			suggestions: day.suggestions.map((s) =>
				idSet.has(s.id)
					? { ...s, logged: true, loggedStartedAt: startedById?.get(s.id) }
					: s,
			),
		};
	});
}

/** Bulk-unmark suggestions matching any of `ids`. */
export function applyUnmarkMultipleLogged(
	daySummaries: DaySummary[],
	ids: string[],
): DaySummary[] {
	const idSet = new Set(ids);
	return daySummaries.map((day) => {
		let removed = 0;
		for (const s of day.suggestions) {
			if (idSet.has(s.id) && s.logged) removed += s.suggestedSeconds;
		}
		return {
			...day,
			loggedSeconds: Math.max(0, day.loggedSeconds - removed),
			gapSeconds: day.gapSeconds + removed,
			suggestions: day.suggestions.map((s) =>
				idSet.has(s.id)
					? { ...s, logged: false, loggedStartedAt: undefined }
					: s,
			),
		};
	});
}

/**
 * Removes a suggestion entirely from the day that owns it, then redistributes
 * the remaining active (non-logged) suggestions to fill the day's gap.
 */
export function applyDismissSuggestion(
	daySummaries: DaySummary[],
	suggestionId: string,
	rounding: TimeRounding,
): DaySummary[] {
	return daySummaries.map((day) => {
		const hasSuggestion = day.suggestions.some((s) => s.id === suggestionId);
		if (!hasSuggestion) return day;

		const remaining = day.suggestions.filter((s) => s.id !== suggestionId);
		const active = remaining.filter((s) => !s.logged);
		const logged = remaining.filter((s) => s.logged);

		if (active.length === 0 || day.gapSeconds <= 0) {
			return { ...day, suggestions: remaining };
		}

		const redistributed = distributeSuggestionsToFillGap(
			active,
			day.gapSeconds,
			rounding,
		);
		return { ...day, suggestions: [...redistributed, ...logged] };
	});
}

/**
 * Adjusts a suggestion's duration by `deltaSeconds`, snapping the result to
 * the rounding step (15m / 30m / 60s). Never lets duration go below one step.
 */
export function applyAdjustSuggestionTime(
	daySummaries: DaySummary[],
	suggestionId: string,
	deltaSeconds: number,
	rounding: TimeRounding,
): DaySummary[] {
	const step = roundingStepSeconds(rounding);
	return daySummaries.map((day) => ({
		...day,
		suggestions: day.suggestions.map((s) => {
			if (s.id !== suggestionId) return s;
			const raw = s.suggestedSeconds + deltaSeconds;
			const snapped = Math.round(raw / step) * step;
			const newSeconds = Math.max(step, snapped);
			return {
				...s,
				suggestedSeconds: newSeconds,
				suggestedTimeSpent: formatTimeSpent(newSeconds),
			};
		}),
	}));
}

/**
 * Scales the day's active suggestions so their total fills the remaining gap,
 * honouring the rounding step. Logged suggestions are left untouched.
 */
export function applyFillDayGap(
	daySummaries: DaySummary[],
	date: string,
	rounding: TimeRounding,
): DaySummary[] {
	return daySummaries.map((day) => {
		if (day.date !== date) return day;
		const active = day.suggestions.filter((s) => !s.logged);
		if (active.length === 0 || day.gapSeconds <= 0) return day;
		const scaled = distributeSuggestionsToFillGap(
			active,
			day.gapSeconds,
			rounding,
		);
		const logged = day.suggestions.filter((s) => s.logged);
		return { ...day, suggestions: [...scaled, ...logged] };
	});
}
