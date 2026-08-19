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
 *   - **Known timestamps** (a calendar event, a commit) win over the sequence:
 *     when the real time is known, guessing a slot would be strictly worse.
 *   - **Existing worklogs** are never written over.
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

/**
 * The hours that make up the working day, given every hour that saw activity.
 *
 * The largest contiguous run wins. A real profile showed 00:00-01:00 plus
 * 09:00-16:00 (late-night work, then a normal day) and another showed
 * 09:00-17:00 plus 21:00-23:00: in both, the day's tickets belong in the long
 * block, not the fringe one. Gaps *inside* the winning block are preserved —
 * they are the breaks.
 */
export function workingWindowFromHours(activeHours: number[]): number[] {
	if (activeHours.length === 0) return [];
	const hours = [...new Set(activeHours)].sort((a, b) => a - b);

	const blocks: number[][] = [];
	let current: number[] = [hours[0]];
	for (let i = 1; i < hours.length; i++) {
		// A single missing hour is a break, not a new block; two or more means
		// the person stopped and came back to something else.
		if (hours[i] - hours[i - 1] <= 2) {
			current.push(hours[i]);
		} else {
			blocks.push(current);
			current = [hours[i]];
		}
	}
	blocks.push(current);

	return blocks.reduce((longest, block) =>
		block.length > longest.length ? block : longest,
	);
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function stamp(date: string, minutesFromMidnight: number): string {
	const h = Math.floor(minutesFromMidnight / 60);
	const m = minutesFromMidnight % 60;
	return `${date}T${pad(h)}:${pad(m)}:00`;
}

function minutesOf(iso: string): number {
	const time = iso.slice(11, 16);
	const [h, m] = time.split(':').map(Number);
	return (h || 0) * 60 + (m || 0);
}

interface Busy {
	from: number;
	to: number;
}

function overlaps(busy: Busy[], from: number, to: number): boolean {
	return busy.some((b) => from < b.to && to > b.from);
}

export function layOutDay(input: {
	date: string;
	suggestions: LayoutSuggestion[];
	/** Hours (0-23) that saw activity, from RescueTime. */
	activeHours: number[];
	existing: ExistingWorklog[];
}): LaidOutSuggestion[] {
	const { date, suggestions, activeHours, existing } = input;
	const window = workingWindowFromHours(activeHours);

	const busy: Busy[] = existing.map((e) => ({
		from: minutesOf(e.startedAt),
		to: minutesOf(e.startedAt) + Math.round(e.seconds / 60),
	}));

	const out: LaidOutSuggestion[] = [];

	// Anything with a known time is placed first, so the sequence fills around
	// it rather than the other way round.
	const fixed = suggestions.filter((s) => s.activityAt);
	const floating = suggestions.filter((s) => !s.activityAt);

	for (const s of fixed) {
		const from = minutesOf(s.activityAt as string);
		const to = from + Math.round(s.seconds / 60);
		busy.push({ from, to });
		out.push({ ...s, startedAt: stamp(date, from) });
	}

	// Minutes the day is allowed to use, in order: the active hours, then
	// anything after the last one. Overflow is deliberate — refusing to place a
	// suggestion would silently drop it.
	const slotStarts =
		window.length > 0 ? window.map((h) => h * 60) : [FALLBACK_START_HOUR * 60];

	let cursor = slotStarts[0];
	let slotIndex = 0;

	for (const s of floating) {
		const minutes = Math.round(s.seconds / 60);

		// Walk forward until the block is free and inside an allowed hour.
		for (;;) {
			const slotStart = slotStarts[slotIndex];
			if (slotStart !== undefined && cursor < slotStart) cursor = slotStart;

			if (!overlaps(busy, cursor, cursor + minutes)) break;

			const blocker = busy
				.filter((b) => cursor < b.to && cursor + minutes > b.from)
				.reduce((latest, b) => (b.to > latest ? b.to : latest), cursor);
			cursor = blocker;
		}

		busy.push({ from: cursor, to: cursor + minutes });
		out.push({ ...s, startedAt: stamp(date, cursor) });
		cursor += minutes;

		// Advance past any active hours the placement consumed.
		while (
			slotIndex < slotStarts.length - 1 &&
			slotStarts[slotIndex + 1] <= cursor
		) {
			slotIndex++;
		}
	}

	// Preserve the caller's original ordering.
	const byId = new Map(out.map((s) => [s.id, s]));
	return suggestions.map((s) => byId.get(s.id) as LaidOutSuggestion);
}
