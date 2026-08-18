import type { AbsenceKind } from '../../types/absence';
import { BASELINE_HOURS } from '../constants/timesheet';

export const BASELINE_DAY_SECONDS = BASELINE_HOURS * 3600;

/**
 * Return true when an absence kind is a holiday or PTO (vacation/off).
 * Worklog entries on these dates should be excluded from hour totals
 * (filtered out of the calculation loop).
 */
export function isFlaggedDate(kind?: AbsenceKind): boolean {
	return (
		kind === 'holiday' ||
		kind === 'vacation' ||
		kind === 'off'
	);
}

/**
 * Single source of truth for "what is this day's target?".
 *
 * Rules:
 * - Weekend → 0 (no expectation regardless of absence/work).
 * - Weekday, not absent → BASELINE_DAY_SECONDS (full 8h target).
 * - Weekday, absent (holiday/PTO) → 0 (flagged dates are filtered out of
 *   the calculation loop entirely; worklogs on these dates do not count).
 * - Weekday, absent (sick), 0h logged → 0 (full sick day).
 * - Weekday, absent (sick), 0 < X ≤ 8h logged → X (partial day).
 * - Weekday, absent (sick), > 8h logged → BASELINE_DAY_SECONDS (overtime).
 */
export function computeDayTargetSeconds(
	isWeekend: boolean,
	isAbsent: boolean,
	loggedSeconds: number,
): number {
	if (isWeekend) return 0;
	if (!isAbsent) return BASELINE_DAY_SECONDS;
	const clamped = Math.max(0, loggedSeconds);
	return Math.min(clamped, BASELINE_DAY_SECONDS);
}

/**
 * Sum per-day targets across a list of weekdays. Callers pass lookup
 * functions for absence and logged-seconds so this helper stays agnostic of
 * the data shape (Map, Set, AbsenceDay record, …).
 */
export function sumWeekdayTargetSeconds(
	weekdays: Iterable<string>,
	isAbsent: (day: string) => boolean,
	loggedSeconds: (day: string) => number,
): number {
	let total = 0;
	for (const day of weekdays) {
		total += computeDayTargetSeconds(false, isAbsent(day), loggedSeconds(day));
	}
	return total;
}
