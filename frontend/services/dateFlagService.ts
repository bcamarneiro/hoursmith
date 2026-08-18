import type { AbsenceDay } from './absenceService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A public-holiday entry, compatible with the Nager.Date API response
 * (nagerDateService.ts, ADA-585). Only the fields consumed by date flag
 * checking are required; the full `NagerHoliday` type satisfies this too.
 */
export interface HolidayEntry {
	date: string; // YYYY-MM-DD
	localName: string;
	/** Two-letter ISO country code (used for scoping). */
	countryCode?: string;
}

/** Categories for date-level flags. */
export type DateFlagKind = 'holiday' | 'pto' | 'none';

/** Result of checking a date's flag status. */
export interface DateFlagResult {
	/** The kind of flag, if any. */
	kind: DateFlagKind;
	/** True when the date is a holiday or PTO. */
	isFlagged: boolean;
	/**
	 * Human-readable label provided when flagged:
	 * - holiday → the holiday's localName
	 * - pto     → comma-joined absence reasons
	 */
	reason?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the given date is a public holiday.
 *
 * @param date     ISO date string (YYYY-MM-DD)
 * @param holidays Array of holiday entries to search
 * @returns true if the date appears in the holiday list
 */
export function isHoliday(date: string, holidays: HolidayEntry[]): boolean {
	return holidays.some((h) => h.date === date);
}

/**
 * Look up the local name of a holiday for a given date.
 *
 * @returns the matching holiday name, or `null` if the date is not a holiday
 */
export function getHolidayName(
	date: string,
	holidays: HolidayEntry[],
): string | null {
	return holidays.find((h) => h.date === date)?.localName ?? null;
}

/**
 * Check whether the given date is a PTO / absence day for a user.
 *
 * @param date     ISO date string (YYYY-MM-DD)
 * @param ptoDays  Map of date → AbsenceDay (e.g. `userAbsenceDays.get(email)`)
 * @returns true if the date has an absence entry
 */
export function isPTO(
	date: string,
	ptoDays: Map<string, AbsenceDay>,
): boolean {
	return ptoDays.has(date);
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

/**
 * Unified date flag check — determines whether a date is a public holiday,
 * PTO, or neither, returning all information in a single call.
 *
 * Designed for injection into service and calculation pipelines so that
 * downstream consumers (worklogFilter, useDayCalculation, etc.) can
 * determine date-level flags without juggling two separate data sources.
 *
 * **Priority order:** holiday wins over PTO (if a date is both a public
 * holiday AND in a user's absence feed, it surfaces as holiday).
 *
 * @param date     ISO date string (YYYY-MM-DD)
 * @param holidays Array of holiday entries to check (may be empty)
 * @param ptoDays  Map of date → AbsenceDay for the current user (may be empty)
 * @returns DateFlagResult with kind, isFlagged, and an optional reason
 *
 * @example
 * ```ts
 * const flag = getDateFlag('2024-12-25', holidays, userPTO);
 * // → { kind: 'holiday', isFlagged: true, reason: 'Christmas Day' }
 * ```
 */
export function getDateFlag(
	date: string,
	holidays: HolidayEntry[],
	ptoDays: Map<string, AbsenceDay>,
): DateFlagResult {
	// Holiday takes priority.
	const holiday = holidays.find((h) => h.date === date);
	if (holiday) {
		return {
			kind: 'holiday',
			isFlagged: true,
			reason: holiday.localName,
		};
	}

	// Absence / PTO.
	const absence = ptoDays.get(date);
	if (absence) {
		return {
			kind: 'pto',
			isFlagged: true,
			reason: absence.reasons.join(', '),
		};
	}

	return { kind: 'none', isFlagged: false };
}
