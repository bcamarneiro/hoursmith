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

	it('spills next to the observed hours, not to the far side of the day', () => {
		// An evening worker with more suggested hours than observed: the extra
		// time belongs just before 20:00, not at 00:00 that morning — twenty
		// hours from anything they were seen doing.
		const out = layOutDay({
			date: '2026-08-07',
			suggestions: Array.from({ length: 6 }, (_, i) => ({
				id: `s${i}`,
				seconds: 3600,
			})),
			activeHours: [20, 21, 22, 23],
			existing: [],
		});
		const starts = out.map((s) => s.startedAt.slice(11, 16)).sort();
		expect(starts).toEqual([
			'18:00',
			'19:00',
			'20:00',
			'21:00',
			'22:00',
			'23:00',
		]);
	});

	it('keeps every start distinct even when the day cannot hold them', () => {
		// 30 hours of suggestions in a 24-hour day: something must overlap, but
		// piling six of them on one timestamp is the worst way to do it.
		const out = layOutDay({
			date: '2026-08-07',
			suggestions: Array.from({ length: 30 }, (_, i) => ({
				id: `s${i}`,
				seconds: 3600,
			})),
			activeHours: [9, 10],
			existing: [],
		});
		const starts = out.map((s) => s.startedAt);
		expect(new Set(starts).size).toBe(starts.length);
	});

	it('uses the whole of the last hour instead of collapsing onto 23:00', () => {
		// Reproduced by fuzzing: the clamp was applied when stamping, not when
		// placing, so the interval bookkeeping and the emitted times diverged —
		// two half-hour suggestions in the 23:00 hour both came out at 23:00.
		// 23:30 is a perfectly valid start; the only real limit is 23:59.
		const out = layOutDay({
			date: '2026-08-18',
			suggestions: [
				{ id: 'a', seconds: 1800 },
				{ id: 'b', seconds: 1800 },
			],
			activeHours: [23],
			existing: [],
		});
		expect(out.map((s) => s.startedAt.slice(11, 16))).toEqual([
			'23:00',
			'23:30',
		]);
	});

	it('keeps a late meeting at its real time', () => {
		// The clamp moved a 23:30 event to 23:00 while its busy span stayed at
		// 23:30 — so a floating suggestion was then placed across it.
		const out = layOutDay({
			date: '2026-08-18',
			suggestions: [
				{ id: 'fix', seconds: 1800, activityAt: '2026-08-18T23:30:00' },
				{ id: 'flo', seconds: 5400 },
			],
			activeHours: [22, 23],
			existing: [],
		});
		expect(out.find((s) => s.id === 'fix')?.startedAt).toBe(
			'2026-08-18T23:30:00',
		);
		// And the floating one must not run through it. 22:00 + 90m ends exactly
		// at 23:30, so that placement is correct — the assertion is about
		// overlap, not about a particular hour.
		const flo = out.find((s) => s.id === 'flo');
		const floStart = Number(flo?.startedAt.slice(11, 13)) * 60 +
			Number(flo?.startedAt.slice(14, 16));
		expect(floStart + 90).toBeLessThanOrEqual(23 * 60 + 30);
	});

	it('spills into the gap nearest the working day, not the earliest one', () => {
		// A split backwards-filling interval was searched front-first, so
		// overflow landed at 08:00 while 11:00 — right beside the observed
		// hours — sat free.
		const out = layOutDay({
			date: '2026-08-18',
			suggestions: [
				{ id: 'big', seconds: 12 * 3600 },
				{ id: 'ovf', seconds: 3600 },
			],
			activeHours: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
			existing: [{ startedAt: '2026-08-18T09:00:00', seconds: 3600 }],
		});
		expect(out.find((s) => s.id === 'ovf')?.startedAt).toBe(
			'2026-08-18T11:00:00',
		);
	});

	it('ignores a pinned time that belongs to another day', () => {
		// minutesOf reads only the time characters, so a stamp from a different
		// date would be silently re-dated onto this one.
		const out = layOutDay({
			date: '2026-08-18',
			suggestions: [
				{ id: 'x', seconds: 3600, activityAt: '2026-08-19T14:00:00' },
			],
			activeHours: [9],
			existing: [],
		});
		expect(out[0]?.startedAt).toBe('2026-08-18T09:00:00');
	});

	it('does not fall back onto an existing worklog when the day is full', () => {
		// The last-resort stepper only avoided its own previous emissions, never
		// the already-logged spans, so a saturated day could place a suggestion
		// at minute 0 of a real worklog while later minutes sat free.
		const out = layOutDay({
			date: '2026-08-18',
			suggestions: [
				{ id: 'big', seconds: 200000 },
				{ id: 'a', seconds: 600 },
			],
			activeHours: Array.from({ length: 24 }, (_, i) => i),
			existing: [{ startedAt: '2026-08-18T00:00:00', seconds: 3600 }],
		});
		const a = out.find((s) => s.id === 'a');
		const mins =
			Number(a?.startedAt.slice(11, 13)) * 60 +
			Number(a?.startedAt.slice(14, 16));
		// 00:00-01:00 is logged; the placement must not start inside it.
		expect(mins < 0 || mins >= 60).toBe(true);
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

	it('ignores a busy interval whose duration is not a number', () => {
		// A calendar event with an unparseable DTEND yields NaN seconds. `subtract`
		// compares against NaN, every comparison is false, and the whole interval
		// is dropped rather than split — erasing the afternoon and pushing work
		// outside the working day entirely.
		// Six hours, so the afternoon is actually needed: if the NaN interval
		// swallowed it, the later suggestions would spill *before* 09:00 rather
		// than continuing through the day.
		const out = layOutDay({
			date: '2026-08-03',
			suggestions: Array.from({ length: 6 }, (_, i) => ({
				id: `s${i}`,
				seconds: 3600,
			})),
			activeHours: CONTINUOUS,
			existing: [{ startedAt: '2026-08-03T13:00:00', seconds: Number.NaN }],
		});
		expect(out.map((s) => s.startedAt.slice(11, 16))).toEqual([
			'09:00',
			'10:00',
			'11:00',
			'12:00',
			'13:00',
			'14:00',
		]);
	});

	it('places a suggestion with an unusable duration without corrupting the day', () => {
		const out = layOutDay({
			date: '2026-08-03',
			suggestions: [
				{ id: 'bad', seconds: Number.NaN },
				{ id: 'good', seconds: 3600 },
			],
			activeHours: CONTINUOUS,
			existing: [],
		});
		for (const s of out) {
			expect(s.startedAt).toMatch(/^2026-08-03T\d{2}:\d{2}:00$/);
		}
	});

	it('ignores a fixed time that did not parse', () => {
		// calendarService can emit `T NaN:NaN` for an invalid DTSTART; coercing
		// that to 0 would stamp the suggestion at midnight and block 00:00.
		const out = layOutDay({
			date: '2026-08-03',
			suggestions: [
				{ id: 'meeting', seconds: 3600, activityAt: '2026-08-03TNaN:NaN:00' },
			],
			activeHours: CONTINUOUS,
			existing: [],
		});
		expect(out[0]?.startedAt).toBe('2026-08-03T09:00:00');
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
