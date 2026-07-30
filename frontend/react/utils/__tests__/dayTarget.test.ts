import { describe, expect, it } from 'vitest';
import {
	computeDayTargetSeconds,
	isFlaggedDate,
	sumWeekdayTargetSeconds,
} from '../dayTarget';

describe('isFlaggedDate', () => {
	it('returns true for holiday', () => {
		expect(isFlaggedDate('holiday')).toBe(true);
	});

	it('returns true for vacation', () => {
		expect(isFlaggedDate('vacation')).toBe(true);
	});

	it('returns true for off', () => {
		expect(isFlaggedDate('off')).toBe(true);
	});

	it('returns false for sick', () => {
		expect(isFlaggedDate('sick')).toBe(false);
	});

	it('returns false for undefined', () => {
		expect(isFlaggedDate(undefined)).toBe(false);
	});
});

describe('computeDayTargetSeconds', () => {
	it('returns 0 for weekends', () => {
		expect(computeDayTargetSeconds(true, false, 0)).toBe(0);
		expect(computeDayTargetSeconds(true, false, 28800)).toBe(0);
	});

	it('returns baseline for a normal weekday with no logged time', () => {
		expect(computeDayTargetSeconds(false, false, 0)).toBe(28800);
	});

	it('returns baseline for a normal weekday with overtime', () => {
		expect(computeDayTargetSeconds(false, false, 36000)).toBe(28800);
	});

	it('returns 0 for an absent day with no logged time', () => {
		expect(computeDayTargetSeconds(false, true, 0)).toBe(0);
	});

	it('returns logged seconds for a partial absence day', () => {
		expect(computeDayTargetSeconds(false, true, 14400)).toBe(14400);
	});

	it('caps at baseline even with overtime on an absent day', () => {
		expect(computeDayTargetSeconds(false, true, 36000)).toBe(28800);
	});

	it('handles negative loggedSeconds by clamping to 0', () => {
		expect(computeDayTargetSeconds(false, true, -100)).toBe(0);
	});
});

describe('sumWeekdayTargetSeconds', () => {
	const weekdays = ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'];

	it('sums baselines for all normal days', () => {
		const total = sumWeekdayTargetSeconds(
			weekdays,
			() => false,
			() => 0,
		);
		expect(total).toBe(5 * 28800);
	});

	it('reduces target for absent days', () => {
		const absence = new Set(['2026-03-11']);
		const total = sumWeekdayTargetSeconds(
			weekdays,
			(d) => absence.has(d),
			() => 0,
		);
		// 4 normal days × 8h + 1 absent day × 0h = 32h
		expect(total).toBe(4 * 28800);
	});
});
