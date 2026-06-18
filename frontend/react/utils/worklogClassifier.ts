import type { JiraWorklog } from '../../../types/jira';
import { wallClockDay } from './date';

export type BackdateSource = 'none' | 'comment' | 'jira-native';

export interface ClassifiedWorklog {
	loggedOn: string;
	intendedFor: string;
	daysLate: number;
	isBackdated: boolean;
	source: BackdateSource;
	originalComment: string;
}

export interface ClassifierOptions {
	commentPatterns?: RegExp[];
	thresholdDays?: number;
}

export const DEFAULT_BACKDATE_PATTERNS: RegExp[] = [
	/Original Worklog Date was:\s*(\d{4})[/-](\d{2})[/-](\d{2})/i,
	/Originally\s+(?:logged|worked)\s+on:?\s*(\d{4})[/-](\d{2})[/-](\d{2})/i,
];

export const DEFAULT_THRESHOLD_DAYS = 1;

const MS_PER_DAY = 86_400_000;

function extractCommentText(
	comment: string | Record<string, unknown> | undefined,
): string {
	if (!comment) return '';
	if (typeof comment === 'string') return comment;
	if (typeof comment === 'object') {
		try {
			return JSON.stringify(comment);
		} catch {
			return '';
		}
	}
	return '';
}

function toIsoDay(input: string | undefined): string {
	return wallClockDay(input);
}

/**
 * Extract the `±HHMM` / `±HH:MM` / `Z` timezone offset (in minutes) from an
 * ISO instant string, or `null` if the string carries no explicit offset.
 */
function extractOffsetMinutes(input: string | undefined): number | null {
	if (!input) return null;
	if (/(?:Z)$/.test(input)) return 0;
	const match = input.match(/([+-])(\d{2}):?(\d{2})$/);
	if (!match) return null;
	const sign = match[1] === '-' ? -1 : 1;
	const hh = Number(match[2]);
	const mm = Number(match[3]);
	return sign * (hh * 60 + mm);
}

/**
 * The author's wall-clock day for `input`, re-based onto `frameOffsetMinutes`.
 *
 * Jira returns `started` in the worklog's intended offset but `created` is
 * often serialised in UTC (`…Z`). Slicing each string's own prefix then mixes
 * two different frames: a same-evening log in a negative-offset TZ (e.g.
 * started 2025-10-31T23:30-0300, created 2025-11-01T01:00-0300 → 04:00Z) would
 * read created-day = Nov 1 (UTC) vs started-day = Oct 31 and be spuriously
 * flagged as a cross-month backdate. By converting `created` into the same
 * frame as `started` before taking the day, both comparisons share one basis
 * (the author's wall clock), so the false positive disappears (ADA-457/463).
 *
 * Falls back to {@link wallClockDay} when either the input or the frame offset
 * is unavailable.
 */
function wallClockDayInFrame(
	input: string | undefined,
	frameOffsetMinutes: number | null,
): string {
	if (!input || frameOffsetMinutes === null) return wallClockDay(input);
	const ms = Date.parse(input);
	if (Number.isNaN(ms)) return wallClockDay(input);
	// Shift the instant by the frame offset, then read the UTC calendar date —
	// that yields the wall-clock date an observer in `frameOffsetMinutes` sees.
	const shifted = new Date(ms + frameOffsetMinutes * 60_000);
	const year = shifted.getUTCFullYear();
	const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
	const day = String(shifted.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function parseCommentMarker(
	commentText: string,
	patterns: RegExp[],
): string | null {
	for (const pattern of patterns) {
		const match = commentText.match(pattern);
		if (match?.[1] && match[2] && match[3]) {
			const iso = `${match[1]}-${match[2]}-${match[3]}`;
			if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
		}
	}
	return null;
}

function calendarDaysBetween(fromIso: string, toIso: string): number {
	if (!fromIso || !toIso) return 0;
	const from = Date.parse(`${fromIso}T00:00:00Z`);
	const to = Date.parse(`${toIso}T00:00:00Z`);
	if (Number.isNaN(from) || Number.isNaN(to)) return 0;
	return Math.round((to - from) / MS_PER_DAY);
}

export function classifyWorklog(
	worklog: Pick<JiraWorklog, 'started' | 'created' | 'comment'>,
	options: ClassifierOptions = {},
): ClassifiedWorklog {
	const patterns = options.commentPatterns ?? DEFAULT_BACKDATE_PATTERNS;
	const threshold = options.thresholdDays ?? DEFAULT_THRESHOLD_DAYS;

	const commentText = extractCommentText(worklog.comment);
	const startedIso = toIsoDay(worklog.started);
	// Re-base `created` onto the same offset frame as `started` so the
	// backdate comparison is done entirely in the author's wall clock and a
	// same-evening log in a negative-offset TZ isn't spuriously flagged
	// (ADA-457/463). When `started` has no offset we fall back to the plain
	// wall-clock day of `created`.
	const startedOffset = extractOffsetMinutes(worklog.started);
	const createdIso =
		startedOffset !== null
			? wallClockDayInFrame(worklog.created, startedOffset)
			: toIsoDay(worklog.created);

	const commentIntended = parseCommentMarker(commentText, patterns);

	let source: BackdateSource = 'none';
	let loggedOn = startedIso || createdIso;
	let intendedFor = startedIso || createdIso;

	if (commentIntended) {
		source = 'comment';
		intendedFor = commentIntended;
		loggedOn = startedIso || createdIso || commentIntended;
	} else if (
		startedIso &&
		createdIso &&
		createdIso > startedIso &&
		createdIso.slice(0, 7) !== startedIso.slice(0, 7)
	) {
		source = 'jira-native';
		intendedFor = startedIso;
		loggedOn = createdIso;
	}

	const daysLate = Math.max(0, calendarDaysBetween(intendedFor, loggedOn));
	const isBackdated = source !== 'none' && daysLate >= threshold;

	return {
		loggedOn,
		intendedFor,
		daysLate,
		isBackdated,
		source,
		originalComment: commentText,
	};
}
