/**
 * Decide *when* in the day each suggestion should be logged.
 *
 * Every suggestion used to be logged at a hardcoded 09:00, so logging four of
 * them produced four worklogs stacked on the same hour — which is what made
 * Hoursmith's output look nothing like Tempo's calendar, where the day reads as
 * a sequence.
 *
 * The shape of the day is taken from evidence rather than invented:
 *
 *   - **Active hours** come from RescueTime's hourly profile. A real week shows
 *     days starting at 08:00 and days with an empty hour in the middle, so
 *     neither a fixed start nor a fixed lunch rule would be right. Filling only
 *     the hours that had activity reproduces both without either rule — and
 *     works for someone who breaks at 15:00 just as well as at 13:00.
 *   - **Known timestamps** (a calendar event) win over the sequence: when the
 *     real time is known, guessing a slot would be strictly worse.
 *   - **Existing worklogs** are avoided: a suggestion is placed in a free
 *     interval, never starting inside logged time. On a day with no interval
 *     large enough anywhere, the chosen block can still *run into* what
 *     follows — stated plainly here rather than claimed away, because the
 *     alternative is dropping the suggestion, and a visible overlap the user
 *     can adjust beats work that silently disappears.
 *
 * Placement works by building the day's free intervals and filling them, rather
 * than walking a cursor. An earlier cursor-based version could not push itself
 * out of an inactive hour once it landed in one, so the gap-skipping this file
 * exists for silently did not happen.
 */

export interface LayoutSuggestion {
	id: string;
	seconds: number;
	/** When the underlying activity actually happened, if known. */
	activityAt?: string;
}

export interface ExistingWorklog {
	startedAt: string;
	seconds: number;
}

export interface LaidOutSuggestion extends LayoutSuggestion {
	/** Local `YYYY-MM-DDTHH:mm:ss`, no offset — the caller stamps the zone. */
	startedAt: string;
}

/** Used only when nothing at all is known about the day. */
const FALLBACK_START_HOUR = 9;

const MINUTES_IN_DAY = 24 * 60;

/**
 * Latest start we will ever emit. A stamp of `T24:00:00` silently parses as the
 * *next* day and `T25:00:00` is an Invalid Date — which reaches Jira as
 * `NaN-NaN-NaN` and reaches Tempo as a `startTime` its own regex accepts. A
 * valid time on the correct day is better than either.
 */
const LATEST_START_MINUTE = 23 * 60;

/**
 * Hours further apart than this belong to different sittings — late-night work
 * before a normal day, or an evening session after one. Anything closer is a
 * break *within* the day, including a two-hour lunch, and must not split it.
 */
const MAX_BREAK_HOURS = 3;

/**
 * The hours that make up the working day, given every hour that saw activity.
 *
 * Hours are grouped into sittings, and the longest sitting wins: a real profile
 * showed 00:00-01:00 plus 09:00-16:00, and another 09:00-17:00 plus
 * 21:00-23:00. In both, the day's tickets belong in the long stretch. Gaps
 * *inside* the winner are kept — they are the breaks, and skipping them is the
 * point.
 */
export function workingWindowFromHours(activeHours: number[]): number[] {
	if (activeHours.length === 0) return [];
	const hours = [...new Set(activeHours)].sort((a, b) => a - b);

	const sittings: number[][] = [];
	let current: number[] = [hours[0]];
	for (let i = 1; i < hours.length; i++) {
		if (hours[i] - hours[i - 1] <= MAX_BREAK_HOURS) {
			current.push(hours[i]);
		} else {
			sittings.push(current);
			current = [hours[i]];
		}
	}
	sittings.push(current);

	return sittings.reduce((longest, sitting) =>
		sitting.length > longest.length ? sitting : longest,
	);
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function stamp(date: string, minutesFromMidnight: number): string {
	const clamped = Math.max(
		0,
		Math.min(minutesFromMidnight, LATEST_START_MINUTE),
	);
	return `${date}T${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}:00`;
}

/**
 * Minutes past midnight, read at the timestamp's **own** wall clock.
 *
 * Deliberately not converted to the browser's timezone. The rest of the
 * pipeline attributes a worklog to a day by slicing characters —
 * `classifyWorklog` → `wallClockDay` returns `input.slice(0, 10)` — and Jira
 * and Tempo display it at that same wall clock. Converting would put the two
 * readings an offset apart: a `09:00+02:00` worklog seen from a UTC browser
 * would block 07:00-09:00, and the next suggestion would land at 09:00, on top
 * of it. `toTempoWriteInput` splits `started` textually for the same reason.
 */
function minutesOf(iso: string): number {
	const [h, m] = iso.slice(11, 16).split(':').map(Number);
	return (h || 0) * 60 + (m || 0);
}

interface Interval {
	from: number;
	to: number;
}

/** Contiguous runs of active hours, as minute intervals. */
function intervalsFromHours(hours: number[]): Interval[] {
	if (hours.length === 0) {
		return [{ from: FALLBACK_START_HOUR * 60, to: MINUTES_IN_DAY }];
	}
	const out: Interval[] = [];
	let start = hours[0];
	let prev = hours[0];
	for (const h of hours.slice(1)) {
		if (h === prev + 1) {
			prev = h;
			continue;
		}
		out.push({ from: start * 60, to: (prev + 1) * 60 });
		start = h;
		prev = h;
	}
	out.push({ from: start * 60, to: (prev + 1) * 60 });
	return out;
}

/**
 * Where placement may spill when the observed hours are all used up: after the
 * day's last active hour first, then before its first.
 *
 * More suggested hours than observed ones means the person worked longer than
 * RescueTime saw. Spreading into the rest of the day is a better answer than
 * repeating one timestamp, which would rebuild the pile this module removes.
 */
function fallbackIntervals(active: Interval[]): Interval[] {
	if (active.length === 0) return [];
	const first = active[0].from;
	const last = active[active.length - 1].to;
	const out: Interval[] = [];
	if (last < MINUTES_IN_DAY) out.push({ from: last, to: MINUTES_IN_DAY });
	if (first > 0) out.push({ from: 0, to: first });
	return out;
}

/**
 * Remove busy spans from the available intervals, **preserving their order**.
 *
 * Order is priority, not chronology: the fallback list is deliberately
 * "after the working day, then before it", and sorting would put the early
 * hours first — placing overflow at 00:00 rather than just after the hours the
 * user was actually seen working.
 */
function subtract(available: Interval[], busy: Interval[]): Interval[] {
	let result = available;
	for (const b of busy) {
		const next: Interval[] = [];
		for (const a of result) {
			if (b.to <= a.from || b.from >= a.to) {
				next.push(a);
				continue;
			}
			if (b.from > a.from) next.push({ from: a.from, to: b.from });
			if (b.to < a.to) next.push({ from: b.to, to: a.to });
		}
		result = next;
	}
	return result;
}

export function layOutDay(input: {
	date: string;
	suggestions: LayoutSuggestion[];
	/** Hours (0-23) that saw activity, from RescueTime. */
	activeHours: number[];
	existing: ExistingWorklog[];
}): LaidOutSuggestion[] {
	const { date, suggestions, activeHours, existing } = input;

	const busy: Interval[] = existing.map((e) => {
		const from = minutesOf(e.startedAt);
		return { from, to: from + Math.round(e.seconds / 60) };
	});

	const out: LaidOutSuggestion[] = [];

	// Known times are placed first so the sequence fills around them.
	const fixed = suggestions.filter((s) => s.activityAt);
	const floating = suggestions.filter((s) => !s.activityAt);

	for (const s of fixed) {
		const from = minutesOf(s.activityAt as string);
		busy.push({ from, to: from + Math.round(s.seconds / 60) });
		out.push({ ...s, startedAt: stamp(date, from) });
	}

	const active = intervalsFromHours(workingWindowFromHours(activeHours));
	// Two tiers, searched in order. A single sorted list cannot express this:
	// the spill-over before the day's first active hour would sort first and be
	// used ahead of the hours the user actually worked.
	let preferred = subtract(active, busy);
	let fallback = subtract(fallbackIntervals(active), busy);

	for (const s of floating) {
		const minutes = Math.max(1, Math.round(s.seconds / 60));

		// Observed hours first; only then the rest of the day. Repeating one
		// clamped time would rebuild the pile this module exists to remove.
		const slot =
			preferred.find((i) => i.to - i.from >= minutes) ??
			fallback.find((i) => i.to - i.from >= minutes) ??
			preferred[0] ??
			fallback[0];

		// Nothing free anywhere: only reachable with more than a day of
		// suggestions.
		const start = slot ? slot.from : LATEST_START_MINUTE;
		const taken = [{ from: start, to: start + minutes }];

		out.push({ ...s, startedAt: stamp(date, start) });
		preferred = subtract(preferred, taken);
		fallback = subtract(fallback, taken);
	}

	// Preserve the caller's original ordering.
	const byId = new Map(out.map((s) => [s.id, s]));
	return suggestions.map((s) => byId.get(s.id) as LaidOutSuggestion);
}
