/**
 * Days of the week (0 = Sunday … 6 = Saturday) treated as non-working days.
 *
 * Single source of truth for the weekend definition (ADA-464). All weekend
 * checks across the app route through {@link isWeekend} / {@link isWeekendDay}
 * so a future "configurable workweek" change (ADA-392) only needs one edit.
 * Defaults to Saturday + Sunday, preserving the previous hardcoded behaviour.
 */
export const WEEKEND_DAYS: ReadonlySet<number> = new Set([0, 6]);

/**
 * True when the given JS weekday index (0 = Sunday … 6 = Saturday) is a
 * weekend day. Prefer {@link isWeekend} when you have a `YYYY-MM-DD` string.
 */
export function isWeekendDay(dayOfWeek: number): boolean {
	return WEEKEND_DAYS.has(dayOfWeek);
}

/**
 * True when the given `YYYY-MM-DD` date string falls on a weekend. Parses the
 * date in local time (via {@link parseIsoDateLocal}) so the weekday is read
 * from the wall-clock date, not a UTC-shifted one.
 */
export function isWeekend(dateStr: string): boolean {
	return isWeekendDay(parseIsoDateLocal(dateStr).getDay());
}

export function getMonthStartWeekday(
	year: number,
	monthZeroIndexed: number,
): number {
	return new Date(Date.UTC(year, monthZeroIndexed, 1)).getUTCDay();
}

export function getDaysInMonth(year: number, monthZeroIndexed: number): number {
	return new Date(Date.UTC(year, monthZeroIndexed + 1, 0)).getUTCDate();
}

export function isoDateFromYMD(
	year: number,
	monthZeroIndexed: number,
	day: number,
): string {
	const d = new Date(Date.UTC(year, monthZeroIndexed, day));
	return d.toISOString().substring(0, 10);
}

export function monthLabel(year: number, monthZeroIndexed: number): string {
	return new Date(Date.UTC(year, monthZeroIndexed, 1)).toLocaleString(
		undefined,
		{ month: 'long', year: 'numeric', timeZone: 'UTC' },
	);
}

/**
 * Check if a date string (YYYY-MM-DD) falls within the specified month.
 */
export function isDateInMonth(
	dateStr: string,
	year: number,
	monthZeroIndexed: number,
): boolean {
	const [dateYear, dateMonth] = dateStr.split('-').map(Number);
	return dateYear === year && dateMonth === monthZeroIndexed + 1;
}

/**
 * Count the number of weekdays (Mon-Fri) in a given month.
 */
export function getWorkingDaysInMonth(
	year: number,
	monthZeroIndexed: number,
): number {
	const numDays = getDaysInMonth(year, monthZeroIndexed);
	let count = 0;
	for (let d = 1; d <= numDays; d++) {
		const day = new Date(Date.UTC(year, monthZeroIndexed, d)).getUTCDay();
		if (!isWeekendDay(day)) count++;
	}
	return count;
}

/**
 * Returns the ISO date strings (YYYY-MM-DD) for every weekday (Mon-Fri) in
 * the given month. Used by per-day target rollups so each surface can iterate
 * the same canonical list.
 */
export function getWorkdayDatesInMonth(
	year: number,
	monthZeroIndexed: number,
): string[] {
	const numDays = getDaysInMonth(year, monthZeroIndexed);
	const dates: string[] = [];
	for (let d = 1; d <= numDays; d++) {
		const day = new Date(Date.UTC(year, monthZeroIndexed, d)).getUTCDay();
		if (!isWeekendDay(day)) {
			dates.push(isoDateFromYMD(year, monthZeroIndexed, d));
		}
	}
	return dates;
}

/**
 * Extract local date string (YYYY-MM-DD) from an ISO date string or Date object.
 * This avoids timezone conversion issues that occur with toISOString().
 */
export function toLocalDateString(dateInput: string | Date): string {
	const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * Canonical "what day did this happen for the author?" extractor.
 *
 * For ISO strings with explicit TZ offset (e.g. "2025-10-05T23:30:00.000-0300"),
 * we slice the wall-clock prefix so the day matches what the author saw at
 * their desk — independent of viewer TZ. For inputs without TZ info we
 * fall back to local-TZ conversion via {@link toLocalDateString}.
 *
 * Returns an empty string for `undefined` or unparseable input.
 */
export function wallClockDay(input: string | Date | undefined): string {
	if (input === undefined || input === null) return '';
	if (typeof input === 'string') {
		if (input.length === 0) return '';
		const slice = input.slice(0, 10);
		if (/^\d{4}-\d{2}-\d{2}$/.test(slice)) return slice;
		const parsed = new Date(input);
		if (Number.isNaN(parsed.getTime())) return '';
		return toLocalDateString(parsed);
	}
	if (Number.isNaN(input.getTime())) return '';
	return toLocalDateString(input);
}

export function parseIsoDateLocal(dateStr: string): Date {
	const [year, month, day] = dateStr.split('-').map(Number);
	return new Date(year, month - 1, day);
}

export function addDaysToIsoDate(dateStr: string, days: number): string {
	const date = parseIsoDateLocal(dateStr);
	date.setDate(date.getDate() + days);
	return toLocalDateString(date);
}

/**
 * Append the local TZ offset to a `YYYY-MM-DDTHH:MM` string so Jira can
 * interpret it unambiguously. Output: `YYYY-MM-DDTHH:MM:00.000±HHMM`.
 *
 * Used at every site that POSTs/PUTs a worklog `started` field.
 *
 * Idempotent: if the input already ends with a `±HHMM` offset, returns it
 * unchanged.
 */
export function withLocalOffset(localDateTime: string): string {
	// If the input already carries a `±HHMM` offset, leave it alone.
	if (/[+-]\d{4}$/.test(localDateTime)) return localDateTime;

	const date = new Date(localDateTime);
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? '+' : '-';
	const abs = Math.abs(offsetMinutes);
	const hh = String(Math.floor(abs / 60)).padStart(2, '0');
	const mm = String(abs % 60).padStart(2, '0');
	// Normalise to `YYYY-MM-DDTHH:MM:00.000` then append offset.
	const base =
		localDateTime.length === 16 ? `${localDateTime}:00.000` : localDateTime;
	return `${base}${sign}${hh}${mm}`;
}

/**
 * Compute the Monday of the week that contains `date`, in local TZ.
 * Single source of truth shared by useDashboardStore and useTeamStore so
 * any future change (e.g. Sunday-first week) only needs one edit.
 */
export function getMondayOfWeek(date: Date): string {
	const d = new Date(date);
	const day = d.getDay();
	const diff = d.getDate() - day + (day === 0 ? -6 : 1);
	d.setDate(diff);
	return toLocalDateString(d);
}

/**
 * The calendar month a Monday-anchored week "belongs" to.
 *
 * When a week straddles a month boundary, attributing the week to its Monday
 * (which may still sit in the previous month) makes a month view show the wrong
 * month (ADA-457/463). We follow the ISO-8601 rule and anchor on the week's
 * Thursday (Monday + 3 days) — the week belongs to whichever month contains the
 * majority of its days. Returns `{ year, month }` with a zero-indexed month.
 */
export function getWeekMonthAnchor(weekStartIso: string): {
	year: number;
	month: number;
} {
	const thursdayIso = addDaysToIsoDate(weekStartIso, 3);
	const anchor = parseIsoDateLocal(thursdayIso);
	return { year: anchor.getFullYear(), month: anchor.getMonth() };
}

export function formatDateTimeLocalValue(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	return `${year}-${month}-${day}T${hours}:${minutes}`;
}
