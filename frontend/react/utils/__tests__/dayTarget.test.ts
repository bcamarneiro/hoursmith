import { describe, expect, it } from 'vitest';
import {
	BASELINE_DAY_SECONDS,
	computeDayTargetSeconds,
	sumWeekdayTargetSeconds,
} from '../dayTarget';

describe('computeDayTargetSeconds', () => {
	it('weekend → 0 regardless of absence or hours', () => {
		expect(computeDayTargetSeconds(true, false, 0)).toBe(0);
		expect(computeDayTargetSeconds(true, true, 0)).toBe(0);
		expect(computeDayTargetSeconds(true, false, 4 * 3600)).toBe(0);
		expect(computeDayTargetSeconds(true, true, 4 * 3600)).toBe(0);
	});

	it('weekday, not absent → 8h baseline', () => {
		expect(computeDayTargetSeconds(false, false, 0)).toBe(BASELINE_DAY_SECONDS);
		expect(computeDayTargetSeconds(false, false, 4 * 3600)).toBe(
			BASELINE_DAY_SECONDS,
		);
		// Overtime above baseline does not affect target.
		expect(computeDayTargetSeconds(false, false, 12 * 3600)).toBe(
			BASELINE_DAY_SECONDS,
		);
	});

	it('weekday, absent, no work logged → 0 (full day off)', () => {
		expect(computeDayTargetSeconds(false, true, 0)).toBe(0);
	});

	it('weekday, absent, partial work logged → target tracks logged hours', () => {
		expect(computeDayTargetSeconds(false, true, 4 * 3600)).toBe(4 * 3600);
		expect(computeDayTargetSeconds(false, true, 1800)).toBe(1800);
	});

	it('weekday, absent, full 8h logged → 8h target (100% compliant)', () => {
		expect(computeDayTargetSeconds(false, true, BASELINE_DAY_SECONDS)).toBe(
			BASELINE_DAY_SECONDS,
		);
	});

	it('weekday, absent, more than 8h logged → capped at 8h baseline', () => {
		expect(computeDayTargetSeconds(false, true, 12 * 3600)).toBe(
			BASELINE_DAY_SECONDS,
		);
	});

	it('treats negative logged seconds as 0', () => {
		expect(computeDayTargetSeconds(false, true, -100)).toBe(0);
	});

	it('honours a custom daily target (ADA-392)', () => {
		const sixHours = 6 * 3600;
		// Not absent → the custom target, not the 8h baseline.
		expect(computeDayTargetSeconds(false, false, 0, sixHours)).toBe(sixHours);
		// Absent, partial work below the custom target → tracks logged.
		expect(computeDayTargetSeconds(false, true, 2 * 3600, sixHours)).toBe(
			2 * 3600,
		);
		// Absent, work above the custom target → capped at the custom target.
		expect(computeDayTargetSeconds(false, true, 10 * 3600, sixHours)).toBe(
			sixHours,
		);
		// Weekend is still 0 regardless of the custom target.
		expect(computeDayTargetSeconds(true, false, 0, sixHours)).toBe(0);
	});
});

describe('sumWeekdayTargetSeconds', () => {
	const weekdays = [
		'2026-03-02',
		'2026-03-03',
		'2026-03-04',
		'2026-03-05',
		'2026-03-06',
	];

	it('returns full week × 8h when no absences and no logs', () => {
		const total = sumWeekdayTargetSeconds(
			weekdays,
			() => false,
			() => 0,
		);
		expect(total).toBe(5 * BASELINE_DAY_SECONDS);
	});

	it('drops 8h for an untouched absence day', () => {
		const absent = new Set(['2026-03-04']);
		const total = sumWeekdayTargetSeconds(
			weekdays,
			(d) => absent.has(d),
			() => 0,
		);
		expect(total).toBe(4 * BASELINE_DAY_SECONDS);
	});

	it('partial-day absence: deducts only the unworked portion', () => {
		const absent = new Set(['2026-03-04']);
		const logged = new Map([['2026-03-04', 4 * 3600]]);
		const total = sumWeekdayTargetSeconds(
			weekdays,
			(d) => absent.has(d),
			(d) => logged.get(d) ?? 0,
		);
		// 4 normal days (8h) + 1 absent day with 4h logged → 4*8 + 4 = 36h
		expect(total).toBe(4 * BASELINE_DAY_SECONDS + 4 * 3600);
	});

	it('overtime on an absence day does not reinflate the target', () => {
		const absent = new Set(['2026-03-04']);
		const logged = new Map([['2026-03-04', 12 * 3600]]);
		const total = sumWeekdayTargetSeconds(
			weekdays,
			(d) => absent.has(d),
			(d) => logged.get(d) ?? 0,
		);
		// Capped at 8h on the absence day → identical to a normal week.
		expect(total).toBe(5 * BASELINE_DAY_SECONDS);
	});

	it('sums against a custom daily target across the week (ADA-392)', () => {
		const sixHours = 6 * 3600;
		const total = sumWeekdayTargetSeconds(
			weekdays,
			() => false,
			() => 0,
			sixHours,
		);
		expect(total).toBe(5 * sixHours);
	});
});
