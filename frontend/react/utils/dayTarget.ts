import { BASELINE_HOURS } from '../constants/timesheet';

export const BASELINE_DAY_SECONDS = BASELINE_HOURS * 3600;

/**
 * Single source of truth for "what is this day's target?".
 *
 * Rules (with `dailyTargetSeconds` = the member's per-weekday target, default
 * BASELINE_DAY_SECONDS = 8h — overridable per user via ADA-392):
 * - Weekend → 0 (no expectation regardless of absence/work).
 * - Weekday, not absent → dailyTargetSeconds (full day target).
 * - Weekday, absent, 0h logged → 0 (full day off; 100% compliant).
 * - Weekday, absent, 0 < X ≤ target logged → X (partial day; still compliant).
 * - Weekday, absent, > target logged → dailyTargetSeconds (overtime past PTO).
 *
 * Holidays use the same `isAbsent` channel, so a worked-on-holiday is treated
 * the same as a worked-on-vacation.
 */
export function computeDayTargetSeconds(
	isWeekend: boolean,
	isAbsent: boolean,
	loggedSeconds: number,
	dailyTargetSeconds: number = BASELINE_DAY_SECONDS,
): number {
	if (isWeekend) return 0;
	if (!isAbsent) return dailyTargetSeconds;
	const clamped = Math.max(0, loggedSeconds);
	return Math.min(clamped, dailyTargetSeconds);
}

/**
 * Sum per-day targets across a list of weekdays. Callers pass lookup
 * functions for absence and logged-seconds so this helper stays agnostic of
 * the data shape (Map, Set, AbsenceDay record, …). `dailyTargetSeconds`
 * defaults to the 8h baseline; pass a per-user value to honour ADA-392
 * working-hours overrides.
 */
export function sumWeekdayTargetSeconds(
	weekdays: Iterable<string>,
	isAbsent: (day: string) => boolean,
	loggedSeconds: (day: string) => number,
	dailyTargetSeconds: number = BASELINE_DAY_SECONDS,
): number {
	let total = 0;
	for (const day of weekdays) {
		total += computeDayTargetSeconds(
			false,
			isAbsent(day),
			loggedSeconds(day),
			dailyTargetSeconds,
		);
	}
	return total;
}
