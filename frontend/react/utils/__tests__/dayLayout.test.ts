import { describe, expect, it } from 'vitest';
import { layOutDay, workingWindowFromHours } from '../dayLayout';

/**
 * Hourly profiles below are real, taken from a live RescueTime account for the
 * week of 3 Aug 2026. They are the four shapes a day actually takes:
 * continuous, with a mid-day gap, split by late-night work, and split by
 * evening work.
 *
 * RescueTime reports these in the account's local timezone (verified: its
 * latest hour matched the browser's local hour exactly), so no conversion is
 * involved here.
 */
const CONTINUOUS = [9, 10, 11, 12, 13, 14, 15, 16]; // Mon 3 Aug
const WITH_GAP = [9, 10, 12, 13, 14, 15, 16, 17]; // Fri 7 Aug — 11h empty
const LATE_NIGHT_PLUS_DAY = [0, 1, 9, 10, 11, 12, 13, 14, 15, 16]; // Wed 5 Aug
const DAY_PLUS_EVENING = [9, 10, 11, 12, 13, 14, 15, 16, 17, 21, 22, 23]; // Thu 6

describe('workingWindowFromHours', () => {
	it('takes a continuous day as it is', () => {
		expect(workingWindowFromHours(CONTINUOUS)).toEqual(CONTINUOUS);
	});

	it('keeps the gap rather than smoothing over it', () => {
		// The 11h hole is a break. Preserving it is what removes the need for a
		// hardcoded lunch rule — and for someone who breaks at 15h instead, the
		// same code does the right thing.
		expect(workingWindowFromHours(WITH_GAP)).toEqual(WITH_GAP);
	});

	it('ignores late-night hours in favour of the main block', () => {
		// Working 00:00-01:00 is real, but it is not where a day's tickets
		// belong. The largest contiguous block is the working day.
		expect(workingWindowFromHours(LATE_NIGHT_PLUS_DAY)).toEqual([
			9, 10, 11, 12, 13, 14, 15, 16,
		]);
	});

	it('ignores an evening block in favour of the longer daytime one', () => {
		expect(workingWindowFromHours(DAY_PLUS_EVENING)).toEqual([
			9, 10, 11, 12, 13, 14, 15, 16, 17,
		]);
	});

	it('returns nothing when there was no activity', () => {
		expect(workingWindowFromHours([])).toEqual([]);
	});
});

describe('layOutDay', () => {
	const day = '2026-08-03';

	it('places one suggestion at the first active hour, not a fixed 09:00', () => {
		// Today's real profile started at 08:00. A hardcoded 09:00 was simply
		// wrong for this user.
		const out = layOutDay({
			date: day,
			suggestions: [{ id: 'a', seconds: 3600 }],
			activeHours: [8, 9, 10],
			existing: [],
		});
		expect(out[0]?.startedAt).toBe('2026-08-03T08:00:00');
	});

	it('places the next suggestion after the previous one ends', () => {
		const out = layOutDay({
			date: day,
			suggestions: [
				{ id: 'a', seconds: 2 * 3600 },
				{ id: 'b', seconds: 3600 },
			],
			activeHours: CONTINUOUS,
			existing: [],
		});
		expect(out.map((s) => s.startedAt)).toEqual([
			'2026-08-03T09:00:00',
			'2026-08-03T11:00:00',
		]);
	});

	it('skips an inactive hour instead of logging through the break', () => {
		// Two 1h suggestions on the 7 Aug profile: the second must land at 12:00,
		// not 10:00→11:00, because 11:00 had no activity.
		const out = layOutDay({
			date: '2026-08-07',
			suggestions: [
				{ id: 'a', seconds: 3600 },
				{ id: 'b', seconds: 3600 },
			],
			activeHours: WITH_GAP,
			existing: [],
		});
		expect(out.map((s) => s.startedAt)).toEqual([
			'2026-08-07T09:00:00',
			'2026-08-07T10:00:00',
		]);
	});

	it('starts after a worklog that is already logged', () => {
		// Never place on top of real logged time.
		const out = layOutDay({
			date: day,
			suggestions: [{ id: 'a', seconds: 3600 }],
			activeHours: CONTINUOUS,
			existing: [{ startedAt: '2026-08-03T09:00:00', seconds: 2 * 3600 }],
		});
		expect(out[0]?.startedAt).toBe('2026-08-03T11:00:00');
	});

	it('fills the gap before an existing worklog when one fits', () => {
		// Existing 11:00-13:00, day starts at 09:00: a one-hour suggestion
		// belongs at 09:00, not pushed past the block.
		const out = layOutDay({
			date: day,
			suggestions: [{ id: 'a', seconds: 3600 }],
			activeHours: CONTINUOUS,
			existing: [{ startedAt: '2026-08-03T11:00:00', seconds: 2 * 3600 }],
		});
		expect(out[0]?.startedAt).toBe('2026-08-03T09:00:00');
	});

	it('honours a known activity time over the sequence', () => {
		// A calendar event at 14:00 happened at 14:00; guessing a slot for it
		// would be worse than the truth we already hold.
		const out = layOutDay({
			date: day,
			suggestions: [
				{ id: 'meeting', seconds: 3600, activityAt: '2026-08-03T14:00:00' },
				{ id: 'work', seconds: 3600 },
			],
			activeHours: CONTINUOUS,
			existing: [],
		});
		const meeting = out.find((s) => s.id === 'meeting');
		expect(meeting?.startedAt).toBe('2026-08-03T14:00:00');
	});

	it('does not let a sequenced item overlap a fixed one', () => {
		const out = layOutDay({
			date: day,
			suggestions: [
				{ id: 'meeting', seconds: 3600, activityAt: '2026-08-03T09:00:00' },
				{ id: 'work', seconds: 3600 },
			],
			activeHours: CONTINUOUS,
			existing: [],
		});
		expect(out.find((s) => s.id === 'work')?.startedAt).toBe(
			'2026-08-03T10:00:00',
		);
	});

	it('falls back to 09:00 when nothing is known about the day', () => {
		// No RescueTime, no timestamps: the old behaviour, but only as a last
		// resort rather than always.
		const out = layOutDay({
			date: day,
			suggestions: [{ id: 'a', seconds: 3600 }],
			activeHours: [],
			existing: [],
		});
		expect(out[0]?.startedAt).toBe('2026-08-03T09:00:00');
	});

	it('keeps going past the last active hour rather than dropping work', () => {
		// More hours to log than hours observed. Overflowing is right: refusing
		// to place a suggestion would silently lose it.
		const out = layOutDay({
			date: day,
			suggestions: [
				{ id: 'a', seconds: 3600 },
				{ id: 'b', seconds: 3600 },
			],
			activeHours: [9],
			existing: [],
		});
		expect(out).toHaveLength(2);
		expect(out[1]?.startedAt).toBe('2026-08-03T10:00:00');
	});
});
