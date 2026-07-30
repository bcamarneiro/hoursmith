import { describe, expect, it } from 'vitest';
import {
	getDateFlag,
	getHolidayName,
	isHoliday,
	isPTO,
} from '../dateFlagService';
import type { HolidayEntry } from '../dateFlagService';
import type { AbsenceDay } from '../absenceService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const holidays2024: HolidayEntry[] = [
	{
		date: '2024-01-01',
		localName: 'Dia de Ano Novo',
		countryCode: 'PT',
	},
	{
		date: '2024-04-25',
		localName: 'Dia da Liberdade',
		countryCode: 'PT',
	},
	{
		date: '2024-12-25',
		localName: 'Natal',
		countryCode: 'PT',
	},
];

const ptoDays = new Map<string, AbsenceDay>([
	[
		'2024-03-15',
		{ date: '2024-03-15', reasons: ['Dentist appointment'], kind: 'off' },
	],
	[
		'2024-07-22',
		{ date: '2024-07-22', reasons: ['Family vacation'], kind: 'vacation' },
	],
	[
		'2024-12-25',
		{ date: '2024-12-25', reasons: ['Personal day'], kind: 'off' },
	],
]);

// ---------------------------------------------------------------------------
// isHoliday
// ---------------------------------------------------------------------------

describe('isHoliday', () => {
	it('returns true when the date is a public holiday', () => {
		expect(isHoliday('2024-01-01', holidays2024)).toBe(true);
	});

	it('returns false when the date is not a public holiday', () => {
		expect(isHoliday('2024-06-15', holidays2024)).toBe(false);
	});

	it('returns false for an empty holiday list', () => {
		expect(isHoliday('2024-01-01', [])).toBe(false);
	});

	it('returns true regardless of countryCode — matching is date-only', () => {
		expect(isHoliday('2024-12-25', holidays2024)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getHolidayName
// ---------------------------------------------------------------------------

describe('getHolidayName', () => {
	it('returns the local name for a known holiday', () => {
		expect(getHolidayName('2024-04-25', holidays2024)).toBe(
			'Dia da Liberdade',
		);
	});

	it('returns null for a non-holiday date', () => {
		expect(getHolidayName('2024-06-15', holidays2024)).toBeNull();
	});

	it('returns null for an empty holiday list', () => {
		expect(getHolidayName('2024-01-01', [])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// isPTO
// ---------------------------------------------------------------------------

describe('isPTO', () => {
	it('returns true when the date has an absence entry', () => {
		expect(isPTO('2024-03-15', ptoDays)).toBe(true);
	});

	it('returns false when the date has no absence entry', () => {
		expect(isPTO('2024-03-16', ptoDays)).toBe(false);
	});

	it('returns false for an empty map', () => {
		expect(isPTO('2024-03-15', new Map())).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getDateFlag — unified entry point
// ---------------------------------------------------------------------------

describe('getDateFlag', () => {
	it('returns holiday kind for a public holiday date', () => {
		const result = getDateFlag('2024-01-01', holidays2024, ptoDays);
		expect(result).toEqual({
			kind: 'holiday',
			isFlagged: true,
			reason: 'Dia de Ano Novo',
		});
	});

	it('returns pto kind for an absence day', () => {
		const result = getDateFlag('2024-03-15', holidays2024, ptoDays);
		expect(result).toEqual({
			kind: 'pto',
			isFlagged: true,
			reason: 'Dentist appointment',
		});
	});

	it('returns none for an unflagged date', () => {
		const result = getDateFlag('2024-06-15', holidays2024, ptoDays);
		expect(result).toEqual({
			kind: 'none',
			isFlagged: false,
		});
	});

	it('prioritises holiday over PTO when a date is both', () => {
		// Dec 25 is in both fixtures — holiday should win.
		const result = getDateFlag('2024-12-25', holidays2024, ptoDays);
		expect(result).toEqual({
			kind: 'holiday',
			isFlagged: true,
			reason: 'Natal',
		});
	});

	it('works correctly with empty holiday list', () => {
		const result = getDateFlag('2024-03-15', [], ptoDays);
		expect(result).toEqual({
			kind: 'pto',
			isFlagged: true,
			reason: 'Dentist appointment',
		});
	});

	it('works correctly with empty PTO map', () => {
		const result = getDateFlag('2024-12-25', holidays2024, new Map());
		expect(result).toEqual({
			kind: 'holiday',
			isFlagged: true,
			reason: 'Natal',
		});
	});

	it('returns none when both data sources are empty', () => {
		const result = getDateFlag('2024-12-25', [], new Map());
		expect(result).toEqual({
			kind: 'none',
			isFlagged: false,
		});
	});
});
