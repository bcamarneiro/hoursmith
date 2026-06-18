import { describe, expect, it } from 'vitest';
import {
	addDaysToIsoDate,
	formatDateTimeLocalValue,
	getDaysInMonth,
	getMonthStartWeekday,
	getWeekMonthAnchor,
	isDateInMonth,
	isoDateFromYMD,
	isWeekend,
	isWeekendDay,
	monthLabel,
	parseIsoDateLocal,
	toLocalDateString,
	WEEKEND_DAYS,
	wallClockDay,
	withLocalOffset,
} from '../date';

describe('getMonthStartWeekday', () => {
	it('should return correct weekday for January 2025 (Wednesday = 3)', () => {
		// January 1, 2025 is a Wednesday
		expect(getMonthStartWeekday(2025, 0)).toBe(3);
	});

	it('should return correct weekday for October 2025 (Wednesday = 3)', () => {
		// October 1, 2025 is a Wednesday
		expect(getMonthStartWeekday(2025, 9)).toBe(3);
	});

	it('should return 0 for Sunday start', () => {
		// September 1, 2024 is a Sunday
		expect(getMonthStartWeekday(2024, 8)).toBe(0);
	});

	it('should return 6 for Saturday start', () => {
		// June 1, 2024 is a Saturday
		expect(getMonthStartWeekday(2024, 5)).toBe(6);
	});
});

describe('getDaysInMonth', () => {
	it('should return 31 for January', () => {
		expect(getDaysInMonth(2025, 0)).toBe(31);
	});

	it('should return 28 for February in non-leap year', () => {
		expect(getDaysInMonth(2025, 1)).toBe(28);
	});

	it('should return 29 for February in leap year', () => {
		expect(getDaysInMonth(2024, 1)).toBe(29);
	});

	it('should return 30 for April', () => {
		expect(getDaysInMonth(2025, 3)).toBe(30);
	});

	it('should return 31 for December', () => {
		expect(getDaysInMonth(2025, 11)).toBe(31);
	});
});

describe('isoDateFromYMD', () => {
	it('should format date correctly with single digit day', () => {
		expect(isoDateFromYMD(2025, 0, 5)).toBe('2025-01-05');
	});

	it('should format date correctly with double digit day', () => {
		expect(isoDateFromYMD(2025, 9, 15)).toBe('2025-10-15');
	});

	it('should handle December correctly', () => {
		expect(isoDateFromYMD(2025, 11, 25)).toBe('2025-12-25');
	});

	it('should handle first day of year', () => {
		expect(isoDateFromYMD(2025, 0, 1)).toBe('2025-01-01');
	});

	it('should handle last day of year', () => {
		expect(isoDateFromYMD(2025, 11, 31)).toBe('2025-12-31');
	});
});

describe('monthLabel', () => {
	it('should return formatted month and year', () => {
		const label = monthLabel(2025, 0);
		// Check that it contains the year and some representation of January
		expect(label).toContain('2025');
	});

	it('should handle different months', () => {
		const label = monthLabel(2025, 11);
		expect(label).toContain('2025');
	});
});

describe('isDateInMonth', () => {
	it('should return true for date in correct month', () => {
		expect(isDateInMonth('2025-10-15', 2025, 9)).toBe(true);
	});

	it('should return false for date in different month', () => {
		expect(isDateInMonth('2025-09-15', 2025, 9)).toBe(false);
	});

	it('should return false for date in different year', () => {
		expect(isDateInMonth('2024-10-15', 2025, 9)).toBe(false);
	});

	it('should handle January correctly (month 0)', () => {
		expect(isDateInMonth('2025-01-01', 2025, 0)).toBe(true);
	});

	it('should handle December correctly (month 11)', () => {
		expect(isDateInMonth('2025-12-31', 2025, 11)).toBe(true);
	});

	it('should return false for boundary dates', () => {
		// October 31 is in October (month 9), not November (month 10)
		expect(isDateInMonth('2025-10-31', 2025, 10)).toBe(false);
	});
});

describe('toLocalDateString', () => {
	it('should convert ISO string to local date string', () => {
		const result = toLocalDateString('2025-10-15T09:00:00.000-0300');
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('should convert Date object to local date string', () => {
		const date = new Date(2025, 9, 15); // October 15, 2025
		const result = toLocalDateString(date);
		expect(result).toBe('2025-10-15');
	});

	it('should handle single digit months', () => {
		const date = new Date(2025, 0, 5); // January 5, 2025
		const result = toLocalDateString(date);
		expect(result).toBe('2025-01-05');
	});

	it('should handle single digit days', () => {
		const date = new Date(2025, 9, 1); // October 1, 2025
		const result = toLocalDateString(date);
		expect(result).toBe('2025-10-01');
	});
});

describe('parseIsoDateLocal', () => {
	it('should create a local date without month drift', () => {
		const result = parseIsoDateLocal('2025-10-15');
		expect(result.getFullYear()).toBe(2025);
		expect(result.getMonth()).toBe(9);
		expect(result.getDate()).toBe(15);
	});
});

describe('addDaysToIsoDate', () => {
	it('should roll into the next month correctly', () => {
		expect(addDaysToIsoDate('2025-10-31', 1)).toBe('2025-11-01');
	});

	it('should roll into the previous month correctly', () => {
		expect(addDaysToIsoDate('2025-03-01', -1)).toBe('2025-02-28');
	});
});

describe('wallClockDay', () => {
	it('preserves wall-clock day for ISO strings with explicit TZ offset', () => {
		// Author's wall clock: 2025-10-05 23:30 in -0300 (e.g. São Paulo).
		// In UTC this is 2025-10-06T02:30; in viewer-local it would shift again.
		// We slice the prefix so the day matches what the author saw.
		expect(wallClockDay('2025-10-05T23:30:00.000-0300')).toBe('2025-10-05');
	});

	it('returns YYYY-MM-DD inputs unchanged', () => {
		expect(wallClockDay('2025-10-05')).toBe('2025-10-05');
	});

	it('falls back to local-TZ conversion for Date inputs', () => {
		const date = new Date(2025, 9, 15);
		expect(wallClockDay(date)).toBe('2025-10-15');
	});

	it('returns empty string for undefined input', () => {
		expect(wallClockDay(undefined)).toBe('');
	});

	it('returns empty string for empty string input', () => {
		expect(wallClockDay('')).toBe('');
	});

	it('returns empty string for unparseable input', () => {
		expect(wallClockDay('not-a-date')).toBe('');
	});
});

describe('isWeekendDay / isWeekend / WEEKEND_DAYS', () => {
	it('WEEKEND_DAYS defaults to Saturday + Sunday', () => {
		expect([...WEEKEND_DAYS].sort()).toEqual([0, 6]);
	});

	it('isWeekendDay flags Sat (6) and Sun (0)', () => {
		expect(isWeekendDay(0)).toBe(true);
		expect(isWeekendDay(6)).toBe(true);
		for (let d = 1; d <= 5; d++) expect(isWeekendDay(d)).toBe(false);
	});

	it('isWeekend reads the wall-clock weekday from a YYYY-MM-DD string', () => {
		// 2025-10-04 is a Saturday, 2025-10-05 a Sunday, 2025-10-06 a Monday.
		expect(isWeekend('2025-10-04')).toBe(true);
		expect(isWeekend('2025-10-05')).toBe(true);
		expect(isWeekend('2025-10-06')).toBe(false);
	});

	it('isWeekend parses the date in local time, not UTC (TZ-safe)', () => {
		// A bare YYYY-MM-DD parsed via `new Date(string)` is UTC midnight; read
		// back in a negative-offset TZ it rolls to the previous day. The helper
		// uses parseIsoDateLocal so the weekday is stable regardless of TZ.
		// 2025-10-06 (Mon) must never be treated as Sun under any runner TZ.
		expect(isWeekend('2025-10-06')).toBe(false);
		// 2025-10-12 (Sun) must always read as weekend.
		expect(isWeekend('2025-10-12')).toBe(true);
	});
});

describe('getWeekMonthAnchor', () => {
	it('anchors on the week month when the whole week is in one month', () => {
		// Week of Mon 2025-10-06 → Sun 2025-10-12, fully October.
		expect(getWeekMonthAnchor('2025-10-06')).toEqual({ year: 2025, month: 9 });
	});

	it('anchors on the majority month when the week straddles a boundary', () => {
		// Mon 2025-09-29 → Sun 2025-10-05. Monday is in September but the week's
		// Thursday (2025-10-02) is in October, so the heatmap should show October.
		expect(getWeekMonthAnchor('2025-09-29')).toEqual({ year: 2025, month: 9 });
	});

	it('stays in the earlier month when its Thursday is still there', () => {
		// Mon 2025-10-27 → Sun 2025-11-02. Thursday 2025-10-30 is October.
		expect(getWeekMonthAnchor('2025-10-27')).toEqual({ year: 2025, month: 9 });
	});

	it('handles a year boundary straddle', () => {
		// Mon 2025-12-29 → Sun 2026-01-04. Thursday 2026-01-01 → January 2026.
		expect(getWeekMonthAnchor('2025-12-29')).toEqual({ year: 2026, month: 0 });
	});
});

describe('formatDateTimeLocalValue', () => {
	it('should format dates for datetime-local inputs', () => {
		expect(formatDateTimeLocalValue(new Date(2025, 9, 15, 9, 30))).toBe(
			'2025-10-15T09:30',
		);
	});
});

describe('withLocalOffset', () => {
	it('appends a TZ offset matching the runner local TZ', () => {
		const result = withLocalOffset('2025-10-05T09:00');
		// Format: YYYY-MM-DDTHH:MM:00.000±HHMM
		expect(result).toMatch(/^2025-10-05T09:00:00\.000[+-]\d{4}$/);
		// Offset must be consistent with the runner's TZ.
		const expectedMinutes = -new Date('2025-10-05T09:00').getTimezoneOffset();
		const sign = expectedMinutes >= 0 ? '+' : '-';
		const abs = Math.abs(expectedMinutes);
		const hh = String(Math.floor(abs / 60)).padStart(2, '0');
		const mm = String(abs % 60).padStart(2, '0');
		expect(result.endsWith(`${sign}${hh}${mm}`)).toBe(true);
	});

	it('is idempotent for input that already carries an offset', () => {
		const already = '2025-10-05T09:00:00.000+0200';
		expect(withLocalOffset(already)).toBe(already);
		const negative = '2025-10-05T09:00:00.000-0500';
		expect(withLocalOffset(negative)).toBe(negative);
	});

	it('preserves the local minute and date components', () => {
		const result = withLocalOffset('2025-12-31T23:45');
		expect(result.startsWith('2025-12-31T23:45:00.000')).toBe(true);
	});
});
