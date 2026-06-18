import type {
	DaySummary,
	LoggedWorklog,
	RescueTimeDaySummary,
	WorklogSuggestion,
} from '../../types/Suggestion';
import {
	addDaysToIsoDate,
	isWeekend,
	parseIsoDateLocal,
} from '../react/utils/date';
import { computeDayTargetSeconds } from '../react/utils/dayTarget';
import type {
	FavoriteIssue,
	RecurringTemplate,
} from '../stores/useUserDataStore';
import type { AbsenceDay } from './absenceService';

interface WorklogEntry {
	date: string;
	issueKey?: string;
	issueSummary?: string;
	timeSpentSeconds: number;
	/** Jira worklog id — carried so the day's real worklogs are addressable. */
	worklogId?: string;
	/** Backdated entries are tracked but excluded from `loggedByDay` totals. */
	isBackdated?: boolean;
}

export interface MergeSuggestionsInput {
	weekStart: string;
	jiraSuggestions: WorklogSuggestion[];
	gitlabSuggestions: WorklogSuggestion[];
	calendarSuggestions: WorklogSuggestion[];
	rescueTimeData: Map<string, RescueTimeDaySummary>;
	existingWorklogs: WorklogEntry[];
	favorites?: FavoriteIssue[];
	templates?: RecurringTemplate[];
	timeRounding?: 'off' | '15m' | '30m';
	absenceDates?: Set<string>;
	absenceDays?: Map<string, AbsenceDay>;
}

/**
 * Get Monday-to-Sunday date strings for a given week start.
 */
function getWeekDates(weekStart: string): string[] {
	const dates: string[] = [];
	for (let i = 0; i < 7; i++) {
		dates.push(addDaysToIsoDate(weekStart, i));
	}
	return dates;
}

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
 * Round a duration in seconds to the nearest interval.
 * Always rounds to at least 1 interval (never rounds to zero).
 */
export function roundToInterval(
	seconds: number,
	intervalMinutes: number,
): number {
	const intervalSeconds = intervalMinutes * 60;
	const rounded = Math.round(seconds / intervalSeconds) * intervalSeconds;
	return Math.max(rounded, intervalSeconds);
}

const ROUNDING_INTERVALS: Record<string, number> = {
	'15m': 15,
	'30m': 30,
};

/**
 * Step size in seconds used for incrementing/decrementing suggestion durations.
 *
 * - `'off'` returns 60 (one-minute granularity, no enforced 15-min snap)
 * - `'15m'` returns 900
 * - `'30m'` returns 1800
 */
export function roundingStepSeconds(rounding: 'off' | '15m' | '30m'): number {
	if (rounding === '30m') return 1800;
	if (rounding === '15m') return 900;
	return 60;
}

function applyRounding(
	suggestions: WorklogSuggestion[],
	timeRounding: string | undefined,
): WorklogSuggestion[] {
	if (!timeRounding || timeRounding === 'off') return suggestions;
	const interval = ROUNDING_INTERVALS[timeRounding];
	if (!interval) return suggestions;

	return suggestions.map((s) => {
		const rounded = roundToInterval(s.suggestedSeconds, interval);
		return {
			...s,
			suggestedSeconds: rounded,
			suggestedTimeSpent: formatTimeSpent(rounded),
		};
	});
}

/**
 * Scale suggestion durations using RescueTime data.
 *
 * If RT says the user worked 6h productive but Jira/GitLab only account
 * for 2h of traceable activity, we scale suggestion times up so the total
 * better reflects actual work done.
 */
function scaleSuggestionsWithRT(
	suggestions: WorklogSuggestion[],
	rtData: RescueTimeDaySummary | undefined,
	gapSeconds: number,
): WorklogSuggestion[] {
	if (!rtData || suggestions.length === 0 || gapSeconds <= 0)
		return suggestions;

	const rtProductiveSeconds = rtData.productiveSeconds;
	if (rtProductiveSeconds <= 0) return suggestions;

	const totalSuggested = suggestions.reduce(
		(sum, s) => sum + s.suggestedSeconds,
		0,
	);
	if (totalSuggested <= 0) return suggestions;

	// RT productive time is our best estimate of actual work done.
	// Scale suggestions so their total approaches RT productive time,
	// but never exceed the gap.
	const targetTotal = Math.min(rtProductiveSeconds, gapSeconds);
	const scaleFactor = targetTotal / totalSuggested;

	// Only scale up, not down. If suggestions already exceed RT, leave them.
	if (scaleFactor <= 1) return suggestions;

	// Cap scale factor at 3x to avoid absurd estimates
	const cappedFactor = Math.min(scaleFactor, 3);

	return suggestions.map((s) => {
		const newSeconds = Math.round(s.suggestedSeconds * cappedFactor);
		const cappedSeconds = Math.min(newSeconds, gapSeconds);
		return {
			...s,
			suggestedSeconds: cappedSeconds,
			suggestedTimeSpent: formatTimeSpent(cappedSeconds),
			// Boost confidence when RT backs up the suggestion
			confidence:
				s.confidence === 'low' && cappedFactor > 1.5
					? 'medium'
					: s.confidence === 'medium' && cappedFactor > 2
						? 'high'
						: s.confidence,
		};
	});
}

/**
 * Proportionally scale suggestion durations so they sum to exactly `gapSeconds`.
 *
 * Edge cases:
 * - Empty suggestions array: returns empty array
 * - Zero or negative gap: returns suggestions unchanged
 * - Total suggested already >= gap: returns suggestions unchanged
 */
export function distributeSuggestionsToFillGap(
	suggestions: WorklogSuggestion[],
	gapSeconds: number,
	timeRounding?: 'off' | '15m' | '30m',
): WorklogSuggestion[] {
	if (suggestions.length === 0) return [];
	if (gapSeconds <= 0) return suggestions;

	const totalSuggested = suggestions.reduce(
		(sum, s) => sum + s.suggestedSeconds,
		0,
	);

	// If suggestions already fill or exceed the gap, return unchanged
	if (totalSuggested >= gapSeconds) return suggestions;

	const scaleFactor = gapSeconds / totalSuggested;

	// Scale each suggestion proportionally, then reconcile rounding so the
	// total matches gapSeconds exactly.
	const scaled = suggestions.map((s) => {
		const newSeconds = Math.round(s.suggestedSeconds * scaleFactor);
		return {
			...s,
			suggestedSeconds: newSeconds,
			suggestedTimeSpent: formatTimeSpent(newSeconds),
		};
	});

	// Fix rounding drift: add/subtract the remainder to the largest item
	const scaledTotal = scaled.reduce((sum, s) => sum + s.suggestedSeconds, 0);
	const drift = gapSeconds - scaledTotal;

	if (drift !== 0) {
		// Find the suggestion with the largest suggestedSeconds to absorb drift
		let maxIdx = 0;
		for (let i = 1; i < scaled.length; i++) {
			if (scaled[i].suggestedSeconds > scaled[maxIdx].suggestedSeconds) {
				maxIdx = i;
			}
		}
		const adjusted = scaled[maxIdx].suggestedSeconds + drift;
		scaled[maxIdx] = {
			...scaled[maxIdx],
			suggestedSeconds: adjusted,
			suggestedTimeSpent: formatTimeSpent(adjusted),
		};
	}

	return applyRounding(scaled, timeRounding);
}

/**
 * Merge suggestions from all sources, dedup, filter already-logged issues,
 * and produce a full week of DaySummary objects.
 *
 * Uses RescueTime data to:
 * 1. Scale suggestion durations to match actual productive hours
 * 2. Boost confidence when RT confirms heavy work
 * 3. Show activity breakdown per day
 *
 * Injects favorites and recurring templates as additional suggestions
 * for weekdays where they are not already suggested or logged.
 */
export function mergeSuggestions(input: MergeSuggestionsInput): DaySummary[] {
	const {
		weekStart,
		jiraSuggestions,
		gitlabSuggestions,
		calendarSuggestions,
		rescueTimeData,
		existingWorklogs,
		favorites = [],
		templates = [],
		timeRounding,
		absenceDates,
		absenceDays,
	} = input;

	const dates = getWeekDates(weekStart);

	// Build a set of (date, issueKey) already logged
	const loggedSet = new Set<string>();
	const loggedByDay = new Map<string, number>();
	// Real, non-backdated worklogs grouped per day. Built from the same source
	// as `loggedByDay` so the clonable items and the day total never diverge.
	const loggedWorklogsByDay = new Map<string, LoggedWorklog[]>();

	for (const wl of existingWorklogs) {
		const day = wl.date.slice(0, 10);
		// Backdated entries don't contribute to the day's logged total —
		// they only feed the Dashboard ghost / side-note UI.
		if (!wl.isBackdated) {
			loggedByDay.set(day, (loggedByDay.get(day) || 0) + wl.timeSpentSeconds);
			if (wl.issueKey && wl.worklogId) {
				const list = loggedWorklogsByDay.get(day) ?? [];
				list.push({
					worklogId: wl.worklogId,
					issueKey: wl.issueKey,
					issueSummary: wl.issueSummary,
					timeSpentSeconds: wl.timeSpentSeconds,
				});
				loggedWorklogsByDay.set(day, list);
			}
		}
		if (wl.issueKey) {
			loggedSet.add(`${day}::${wl.issueKey}`);
		}
	}

	// Separate unmapped calendar events (empty issueKey) from mapped suggestions
	const unmappedCalendar: WorklogSuggestion[] = [];
	const mappedCalendar: WorklogSuggestion[] = [];
	for (const s of calendarSuggestions) {
		if (!s.issueKey && s.calendarEventTitle) {
			unmappedCalendar.push(s);
		} else {
			mappedCalendar.push(s);
		}
	}

	// Combine all mapped suggestions
	const allSuggestions = [
		...jiraSuggestions,
		...gitlabSuggestions,
		...mappedCalendar,
	];

	// Deduplicate: same (date, issueKey), keep higher confidence
	const deduped = new Map<string, WorklogSuggestion>();
	const confidenceOrder = { high: 3, medium: 2, low: 1 };

	for (const s of allSuggestions) {
		const key = `${s.date}::${s.issueKey}`;

		// Skip if already logged for this issue on this day
		if (loggedSet.has(key)) continue;

		const existing = deduped.get(key);
		if (
			!existing ||
			confidenceOrder[s.confidence] > confidenceOrder[existing.confidence]
		) {
			deduped.set(key, s);
		}
	}

	// Inject favorite suggestions for each weekday
	for (const date of dates) {
		const d = parseIsoDateLocal(date);
		const dayOfWeek = d.getDay();
		if (isWeekend(date)) continue;

		for (const fav of favorites) {
			const key = `${date}::${fav.issueKey}`;
			if (loggedSet.has(key) || deduped.has(key)) continue;

			deduped.set(key, {
				id: `fav-${fav.issueKey}-${date}`,
				source: 'favorite',
				issueKey: fav.issueKey,
				issueSummary: fav.issueSummary,
				date,
				suggestedTimeSpent: fav.defaultTimeSpent,
				suggestedSeconds: fav.defaultSeconds,
				confidence: 'high',
				reason: 'Pinned issue',
				logged: false,
			});
		}

		// Inject template suggestions for matching days
		for (const tmpl of templates) {
			if (!tmpl.enabled) continue;
			if (!tmpl.daysOfWeek.includes(dayOfWeek)) continue;

			const key = `${date}::${tmpl.issueKey}`;
			if (loggedSet.has(key) || deduped.has(key)) continue;

			deduped.set(key, {
				id: `tmpl-${tmpl.id}-${date}`,
				source: 'template',
				issueKey: tmpl.issueKey,
				issueSummary: tmpl.issueSummary,
				date,
				suggestedTimeSpent: tmpl.timeSpent,
				suggestedSeconds: tmpl.seconds,
				confidence: 'high',
				reason: tmpl.comment || 'Recurring template',
				logged: false,
			});
		}
	}

	// Build day summaries
	return dates.map((date) => {
		const d = parseIsoDateLocal(date);
		const dayOfWeek = d.getDay();
		const weekend = isWeekend(date);
		const loggedSeconds = loggedByDay.get(date) || 0;
		const absenceDay = absenceDays?.get(date);
		const isTimeOff =
			!weekend && (absenceDay ? true : (absenceDates?.has(date) ?? false));
		const targetSeconds = computeDayTargetSeconds(
			weekend,
			isTimeOff,
			loggedSeconds,
		);
		const gapSeconds = Math.max(0, targetSeconds - loggedSeconds);
		const rtDay = rescueTimeData.get(date);

		// Get suggestions for this day
		const daySuggestionsRaw = [...deduped.values()]
			.filter((s) => s.date === date)
			.sort(
				(a, b) => confidenceOrder[b.confidence] - confidenceOrder[a.confidence],
			);

		// Scale suggestions using RescueTime productive hours
		const scaled = scaleSuggestionsWithRT(daySuggestionsRaw, rtDay, gapSeconds);

		// Cap total at gap
		const daySuggestions: WorklogSuggestion[] = [];
		let suggestedTotal = 0;

		for (const s of scaled) {
			if (suggestedTotal >= gapSeconds) break;
			const cappedSeconds = Math.min(
				s.suggestedSeconds,
				gapSeconds - suggestedTotal,
			);
			daySuggestions.push({
				...s,
				suggestedSeconds: cappedSeconds,
				suggestedTimeSpent: formatTimeSpent(cappedSeconds),
			});
			suggestedTotal += cappedSeconds;
		}

		// Apply time rounding if configured
		const roundedSuggestions = applyRounding(daySuggestions, timeRounding);

		// Append unmapped calendar events for this day (not capped by gap —
		// they need user action to map before they can be logged)
		const dayUnmapped = unmappedCalendar.filter((s) => s.date === date);

		return {
			date,
			dayOfWeek,
			isWeekend: weekend,
			loggedSeconds,
			targetSeconds,
			gapSeconds,
			absenceKind: absenceDay?.kind,
			suggestions: [...roundedSuggestions, ...dayUnmapped],
			loggedWorklogs: loggedWorklogsByDay.get(date) ?? [],
			rescueTime: rtDay,
		};
	});
}
