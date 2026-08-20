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

	it('treats a two-hour lunch as one day, not two', () => {
		// 9-11 then 14-17. Taking the longest *contiguous* block would discard
		// the morning and start the day at 14:00 — the opposite of preserving
		// the break, which is what this function is for.
		expect(workingWindowFromHours([9, 10, 11, 14, 15, 16, 17])).toEqual([
			9, 10, 11, 14, 15, 16, 17,
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

	it('jumps over an inactive hour instead of logging through the break', () => {
		// Three 1h suggestions on the 7 Aug profile: 09:00 and 10:00 are active,
		// 11:00 is the break, so the third belongs at 12:00.
		//
		// The previous version of this test asserted 10:00 for the second and
		// stopped there — never reaching the hole it claimed to be about. Its
		// comment said "must land at 12:00" while its assertion said 10:00, so
		// the gap-skipping it existed to protect was never exercised.
		const out = layOutDay({
			date: '2026-08-07',
			suggestions: [
				{ id: 'a', seconds: 3600 },
				{ id: 'b', seconds: 3600 },
				{ id: 'c', seconds: 3600 },
			],
			activeHours: WITH_GAP,
			existing: [],
		});
		expect(out.map((s) => s.startedAt)).toEqual([
			'2026-08-07T09:00:00',
			'2026-08-07T10:00:00',
			'2026-08-07T12:00:00',
		]);
	});

	it('jumps the break when an existing worklog fills the hours before it', () => {
		const out = layOutDay({
			date: '2026-08-07',
			suggestions: [{ id: 'a', seconds: 3600 }],
			activeHours: WITH_GAP,
			existing: [{ startedAt: '2026-08-07T09:00:00', seconds: 2 * 3600 }],
		});
		expect(out[0]?.startedAt).toBe('2026-08-07T12:00:00');
	});

	it('never produces an hour past midnight', () => {
		// Six hours of suggestions on an evening profile would run to 25:00.
		// `new Date('...T25:00:00')` is Invalid Date — the Jira POST would carry
		// NaN — and 'T24:00:00' silently parses as the *next* day, putting the
		// worklog on the wrong date entirely.
		const out = layOutDay({
			date: '2026-08-07',
			suggestions: Array.from({ length: 6 }, (_, i) => ({
				id: `s${i}`,
				seconds: 3600,
			})),
			activeHours: [20, 21, 22, 23],
			existing: [],
		});
		for (const s of out) {
			const hour = Number(s.startedAt.slice(11, 13));
			expect(hour).toBeLessThan(24);
			expect(Number.isNaN(new Date(s.startedAt).getTime())).toBe(false);
		}
	});

	it('reads an existing worklog at its own wall clock, matching how the day is attributed', () => {
		// A previous version converted the offset to browser-local time. That
		// disagrees with the rest of the pipeline: classifyWorklog →
		// wallClockDay slices the first ten characters, so a worklog is filed
		// under the day in *its own* offset, and Jira and Tempo display it at
		// that same wall clock. Converting would block 07:00-09:00 for a
		// 09:00+02:00 worklog seen from a UTC browser — and then place the next
		// suggestion at 09:00, exactly on top of it.
		const out = layOutDay({
			date: '2026-08-03',
			suggestions: [{ id: 'a', seconds: 3600 }],
			activeHours: CONTINUOUS,
			existing: [
				{ startedAt: '2026-08-03T09:00:00.000+0200', seconds: 2 * 3600 },
			],
		});
		expect(out[0]?.startedAt).toBe('2026-08-03T11:00:00');
	});

	it('does not stack the overflow on a single clamped time', () => {
		// Once the day is full, every remaining suggestion used to receive the
		// same 23:00 stamp — reproducing the pile this whole module exists to
		// remove. Asserting only `hour < 24`, as an earlier test did, passes
		// straight over that.
		const out = layOutDay({
			date: '2026-08-07',
			suggestions: Array.from({ length: 6 }, (_, i) => ({
				id: `s${i}`,
				seconds: 3600,
			})),
			activeHours: [20, 21, 22, 23],
			existing: [],
		});
		const starts = out.map((s) => s.startedAt);
		expect(new Set(starts).size).toBe(starts.length);
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
