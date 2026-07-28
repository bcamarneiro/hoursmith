/**
 * On-time logging streaks (ADA-400).
 *
 * Pure computation functions for tracking consecutive weekdays/weeks
 * where the user met their timesheet target. Positive framing only —
 * no shaming for broken streaks.
 *
 * A day is "met" when loggedSeconds >= targetSeconds.
 * Weekends are skipped (they don't count or break streaks).
 * Absence days with target=0 and logged=0 count as "met" (100% compliant).
 */

/** Minimal shape needed from a day summary to compute streaks. */
export interface StreakDayInput {
	date: string;
	isWeekend: boolean;
	loggedSeconds: number;
	targetSeconds: number;
}

/** A single weekday's met-status for streak computation. */
export interface DayMetInfo {
	date: string;
	met: boolean;
}

/**
 * Check if a single day met its target.
 * Weekends should be filtered out before calling this.
 */
export function isDayMet(
	loggedSeconds: number,
	targetSeconds: number,
): boolean {
	return loggedSeconds >= targetSeconds;
}

/**
 * Extract met info from day summaries, filtering out weekends.
 * Returns only weekdays, sorted by date ascending.
 */
export function toWeekdayMetInfo(summaries: StreakDayInput[]): DayMetInfo[] {
	return summaries
		.filter((s) => !s.isWeekend)
		.map((s) => ({
			date: s.date,
			met: isDayMet(s.loggedSeconds, s.targetSeconds),
		}))
		.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Compute current day streak by walking backwards from today.
 *
 * - Starts from today (or skips to most recent past weekday if today
 *   is a weekend or hasn't been logged yet).
 * - Weekends are skipped without breaking the streak.
 * - Future weekdays are skipped without breaking the streak.
 * - Returns 0 if the most recent past weekday was not met.
 */
export function computeCurrentDayStreak(
	weekdays: DayMetInfo[],
	today: string,
): number {
	// Build a map for O(1) lookup
	const metByDate = new Map(weekdays.map((d) => [d.date, d.met]));

	let streak = 0;
	const d = new Date(today + 'T12:00:00');

	// Walk backwards up to 365 days (safety limit)
	for (let i = 0; i < 365; i++) {
		const iso = formatDateISO(d);

		// Skip weekends
		const dow = d.getDay();
		if (dow === 0 || dow === 6) {
			d.setDate(d.getDate() - 1);
			continue;
		}

		// Skip future days (no data yet — doesn't break streak)
		if (iso > today) {
			d.setDate(d.getDate() - 1);
			continue;
		}

		// If we have data for this day, check it
		const met = metByDate.get(iso);
		if (met === undefined) {
			// No data for this weekday — streak ends
			break;
		}
		if (!met) {
			break;
		}

		streak++;
		d.setDate(d.getDate() - 1);
	}

	return streak;
}

/**
 * Check if a set of weekdays represents a fully-met week.
 * All 5 weekdays must be present and met.
 */
export function isWeekComplete(weekdays: DayMetInfo[]): boolean {
	if (weekdays.length < 5) return false;
	return weekdays.every((d) => d.met);
}

/**
 * Group weekdays into ISO weeks (by Monday anchoring).
 * Returns a map of ISO week string -> DayMetInfo[] for that week.
 */
export function groupByWeek(weekdays: DayMetInfo[]): Map<string, DayMetInfo[]> {
	const weeks = new Map<string, DayMetInfo[]>();

	for (const day of weekdays) {
		const d = new Date(day.date + 'T12:00:00');
		// Find the Monday of this week (ISO weeks start on Monday)
		const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
		const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
		const monday = new Date(d);
		monday.setDate(d.getDate() - daysFromMonday);

		// Week key is based on the Monday's date
		const weekKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;

		const existing = weeks.get(weekKey) ?? [];
		existing.push(day);
		weeks.set(weekKey, existing);
	}

	return weeks;
}

/**
 * Compute current week streak by walking backwards from the current week.
 *
 * - A week is "complete" if all 5 weekdays are present and met.
 * - The current week counts if it's complete (all past weekdays met).
 * - Weeks with missing data are skipped (don't break streak).
 * - Returns 0 if the most recent week with data is incomplete.
 */
export function computeCurrentWeekStreak(
	weekdays: DayMetInfo[],
	today: string,
): number {
	const weeks = groupByWeek(weekdays);
	if (weeks.size === 0) return 0;

	// Get current week key (Monday of this week)
	const todayDate = new Date(today + 'T12:00:00');
	const todayDow = todayDate.getDay();
	const daysFromMonday = todayDow === 0 ? 6 : todayDow - 1;
	const currentMonday = new Date(todayDate);
	currentMonday.setDate(todayDate.getDate() - daysFromMonday);
	const currentWeekKey = `${currentMonday.getFullYear()}-${String(currentMonday.getMonth() + 1).padStart(2, '0')}-${String(currentMonday.getDate()).padStart(2, '0')}`;

	// Sort week keys descending and walk backwards
	const sortedKeys = Array.from(weeks.keys()).sort().reverse();

	let streak = 0;

	for (const weekKey of sortedKeys) {
		// Skip future weeks
		if (weekKey > currentWeekKey) continue;

		const weekDays = weeks.get(weekKey)!;

		// Check if this week is complete
		if (isWeekComplete(weekDays)) {
			streak++;
		} else {
			// If this is the current week and it's not yet complete,
			// check if all *past* weekdays are met (partial week)
			if (weekKey === currentWeekKey) {
				const pastWeekdays = weekDays.filter((d) => d.date <= today);
				if (pastWeekdays.length > 0 && pastWeekdays.every((d) => d.met)) {
					// Current week still in progress and all past days met — keep going
					streak++;
				} else {
					break;
				}
			} else {
				break;
			}
		}
	}

	return streak;
}

/** Format a Date as ISO date string (YYYY-MM-DD). */
function formatDateISO(d: Date): string {
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}
