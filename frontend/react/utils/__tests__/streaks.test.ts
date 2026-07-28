import { describe, expect, it } from 'vitest';
import {
	isDayMet,
	toWeekdayMetInfo,
	computeCurrentDayStreak,
	isWeekComplete,
	computeCurrentWeekStreak,
	groupByWeek,
	type StreakDayInput,
} from '../streaks';

// Helper to build a StreakDayInput quickly
function day(
	date: string,
	logged: number,
	target: number,
	isWeekend = false,
): StreakDayInput {
	return { date, loggedSeconds: logged, targetSeconds: target, isWeekend };
}

describe('isDayMet', () => {
	it('met when logged >= target', () => {
		expect(isDayMet(8 * 3600, 8 * 3600)).toBe(true);
		expect(isDayMet(10 * 3600, 8 * 3600)).toBe(true);
	});

	it('not met when logged < target', () => {
		expect(isDayMet(4 * 3600, 8 * 3600)).toBe(false);
		expect(isDayMet(0, 8 * 3600)).toBe(false);
	});

	it('zero target with zero logged is met (absence day)', () => {
		expect(isDayMet(0, 0)).toBe(true);
	});
});

describe('toWeekdayMetInfo', () => {
	it('filters out weekends', () => {
		const summaries: StreakDayInput[] = [
			day('2026-03-02', 8 * 3600, 8 * 3600, false), // Mon
			day('2026-03-07', 0, 0, true), // Sat
			day('2026-03-08', 0, 0, true), // Sun
			day('2026-03-03', 0, 8 * 3600, false), // Tue
		];
		const result = toWeekdayMetInfo(summaries);
		expect(result).toHaveLength(2);
		expect(result[0].date).toBe('2026-03-02');
		expect(result[1].date).toBe('2026-03-03');
	});

	it('sorts by date ascending', () => {
		const summaries: StreakDayInput[] = [
			day('2026-03-04', 8 * 3600, 8 * 3600),
			day('2026-03-02', 8 * 3600, 8 * 3600),
			day('2026-03-03', 8 * 3600, 8 * 3600),
		];
		const result = toWeekdayMetInfo(summaries);
		expect(result.map((d) => d.date)).toEqual([
			'2026-03-02',
			'2026-03-03',
			'2026-03-04',
		]);
	});

	it('marks met status correctly', () => {
		const summaries: StreakDayInput[] = [
			day('2026-03-02', 8 * 3600, 8 * 3600), // met
			day('2026-03-03', 4 * 3600, 8 * 3600), // not met
			day('2026-03-04', 0, 0), // absence, met
		];
		const result = toWeekdayMetInfo(summaries);
		expect(result[0].met).toBe(true);
		expect(result[1].met).toBe(false);
		expect(result[2].met).toBe(true);
	});
});

describe('computeCurrentDayStreak', () => {
	it('counts consecutive met days backwards from today', () => {
		const weekdays = [
			{ date: '2026-03-02', met: true }, // Mon
			{ date: '2026-03-03', met: true }, // Tue
			{ date: '2026-03-04', met: true }, // Wed
			{ date: '2026-03-05', met: false }, // Thu
			{ date: '2026-03-06', met: true }, // Fri
		];
		// Today is Friday 2026-03-06 — streak is 1 (only Fri met, Thu breaks it)
		expect(computeCurrentDayStreak(weekdays, '2026-03-06')).toBe(1);
	});

	it('skips weekends without breaking streak', () => {
		const weekdays = [
			{ date: '2026-03-05', met: true }, // Thu
			{ date: '2026-03-06', met: true }, // Fri
			// Sat/Sun skipped
			{ date: '2026-03-09', met: true }, // Mon (today)
		];
		expect(computeCurrentDayStreak(weekdays, '2026-03-09')).toBe(3);
	});

	it('skips future weekdays without breaking streak', () => {
		const weekdays = [
			{ date: '2026-03-02', met: true }, // Mon
			{ date: '2026-03-03', met: true }, // Tue
			{ date: '2026-03-04', met: true }, // Wed (today)
			// Thu, Fri are future — no data
		];
		expect(computeCurrentDayStreak(weekdays, '2026-03-04')).toBe(3);
	});

	it('returns 0 when today is not met', () => {
		const weekdays = [
			{ date: '2026-03-02', met: true }, // Mon
			{ date: '2026-03-03', met: true }, // Tue
			{ date: '2026-03-04', met: false }, // Wed (today)
		];
		expect(computeCurrentDayStreak(weekdays, '2026-03-04')).toBe(0);
	});

	it('returns 0 for empty input', () => {
		expect(computeCurrentDayStreak([], '2026-03-04')).toBe(0);
	});

	it('handles weekend today by looking at most recent weekday', () => {
		const weekdays = [
			{ date: '2026-03-05', met: true }, // Thu
			{ date: '2026-03-06', met: true }, // Fri
		];
		// Today is Saturday — should start counting from Friday
		expect(computeCurrentDayStreak(weekdays, '2026-03-07')).toBe(2);
	});

	it('absence day with 0 target counts as met', () => {
		const weekdays = [
			{ date: '2026-03-02', met: true }, // Mon
			{ date: '2026-03-03', met: true }, // Tue (absence, 0/0)
			{ date: '2026-03-04', met: true }, // Wed (today)
		];
		expect(computeCurrentDayStreak(weekdays, '2026-03-04')).toBe(3);
	});

	it('handles weekend today with unmet weekday before weekend', () => {
		const weekdays = [
			{ date: '2026-03-02', met: true }, // Mon
			{ date: '2026-03-03', met: true }, // Tue
			{ date: '2026-03-04', met: false }, // Wed - not met
			// Thu/Fri missing (weekend today is Sat)
		];
		// Today is Saturday 2026-03-07 - should return 0 because Wed wasn't met
		expect(computeCurrentDayStreak(weekdays, '2026-03-07')).toBe(0);
	});
});

describe('isWeekComplete', () => {
	it('true when all 5 weekdays met', () => {
		const weekdays = [
			{ date: '2026-03-02', met: true },
			{ date: '2026-03-03', met: true },
			{ date: '2026-03-04', met: true },
			{ date: '2026-03-05', met: true },
			{ date: '2026-03-06', met: true },
		];
		expect(isWeekComplete(weekdays)).toBe(true);
	});

	it('false when any weekday not met', () => {
		const weekdays = [
			{ date: '2026-03-02', met: true },
			{ date: '2026-03-03', met: false },
			{ date: '2026-03-04', met: true },
			{ date: '2026-03-05', met: true },
			{ date: '2026-03-06', met: true },
		];
		expect(isWeekComplete(weekdays)).toBe(false);
	});

	it('false when fewer than 5 weekdays', () => {
		const weekdays = [
			{ date: '2026-03-02', met: true },
			{ date: '2026-03-03', met: true },
		];
		expect(isWeekComplete(weekdays)).toBe(false);
	});
});

describe('groupByWeek', () => {
	it('groups weekdays by ISO week (Thursday-anchored)', () => {
		// Week of Mon 2026-03-02 (Thu = 2026-03-05)
		const weekdays = [
			{ date: '2026-03-02', met: true }, // Mon
			{ date: '2026-03-03', met: true }, // Tue
			{ date: '2026-03-04', met: true }, // Wed
			{ date: '2026-03-05', met: true }, // Thu
			{ date: '2026-03-06', met: true }, // Fri
		];
		const weeks = groupByWeek(weekdays);
		expect(weeks.size).toBe(1);
		// All days should be in one week
		const entries = [...weeks.values()];
		expect(entries[0]).toHaveLength(5);
	});

	it('splits days across week boundary', () => {
		// Week 1: Mon-Fri 2026-03-02 to 2026-03-06
		// Week 2: Mon-Fri 2026-03-09 to 2026-03-13
		const weekdays = [
			{ date: '2026-03-02', met: true },
			{ date: '2026-03-06', met: true },
			{ date: '2026-03-09', met: true },
			{ date: '2026-03-13', met: true },
		];
		const weeks = groupByWeek(weekdays);
		expect(weeks.size).toBe(2);
	});
});

describe('computeCurrentWeekStreak', () => {
	it('counts consecutive complete weeks backwards', () => {
		// Two complete weeks
		const weekdays = [
			// Week 1: 2026-03-02 to 2026-03-06
			{ date: '2026-03-02', met: true },
			{ date: '2026-03-03', met: true },
			{ date: '2026-03-04', met: true },
			{ date: '2026-03-05', met: true },
			{ date: '2026-03-06', met: true },
			// Week 2: 2026-03-09 to 2026-03-13
			{ date: '2026-03-09', met: true },
			{ date: '2026-03-10', met: true },
			{ date: '2026-03-11', met: true },
			{ date: '2026-03-12', met: true },
			{ date: '2026-03-13', met: true },
		];
		// Today is Friday of week 2
		expect(computeCurrentWeekStreak(weekdays, '2026-03-13')).toBe(2);
	});

	it('counts partial current week if all past days met', () => {
		// Week 1 complete, Week 2 partial (Mon-Wed met, today is Wed)
		const weekdays = [
			// Week 1: complete
			{ date: '2026-03-02', met: true },
			{ date: '2026-03-03', met: true },
			{ date: '2026-03-04', met: true },
			{ date: '2026-03-05', met: true },
			{ date: '2026-03-06', met: true },
			// Week 2: partial (Mon-Wed)
			{ date: '2026-03-09', met: true },
			{ date: '2026-03-10', met: true },
			{ date: '2026-03-11', met: true },
		];
		expect(computeCurrentWeekStreak(weekdays, '2026-03-11')).toBe(2);
	});

	it('returns 0 when current week has an unmet day', () => {
		const weekdays = [
			// Week 1: complete
			{ date: '2026-03-02', met: true },
			{ date: '2026-03-03', met: true },
			{ date: '2026-03-04', met: true },
			{ date: '2026-03-05', met: true },
			{ date: '2026-03-06', met: true },
			// Week 2: one day not met
			{ date: '2026-03-09', met: true },
			{ date: '2026-03-10', met: false },
			{ date: '2026-03-11', met: true },
		];
		expect(computeCurrentWeekStreak(weekdays, '2026-03-11')).toBe(0);
	});

	it('returns 0 for empty input', () => {
		expect(computeCurrentWeekStreak([], '2026-03-11')).toBe(0);
	});
});
