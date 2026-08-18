/**
 * Server-side ICS parser for absence polling (ADA-604).
 *
 * Ported from `frontend/services/absenceService.ts` for the Vercel Edge runtime.
 * No browser APIs. The output shape mirrors the client-side parser so callers
 * (cron handler, frontend API) can use it identically.
 *
 * Linear: ADA-604.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AbsenceKind = 'vacation' | 'sick' | 'off' | 'holiday';

export interface AbsenceEvent {
	summary: string;
	dtstart: string;
	dtend: string;
	rrule: string;
	exdates: string[];
}

export interface NormalizedAbsenceDay {
	date: string;
	summary: string;
	kind: AbsenceKind;
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

export function toLocalDateString(dateInput: string | Date): string {
	const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function classifyAbsenceKind(summary: string): AbsenceKind {
	const normalized = summary.trim().toLowerCase();
	if (normalized.includes('sick')) return 'sick';
	if (normalized.includes('vacation')) return 'vacation';
	return 'off';
}

function resolveAbsenceKind(current: AbsenceKind, next: AbsenceKind): AbsenceKind {
	// Priority: a more specific reason wins. Sick > holiday > vacation > off.
	const priority: Record<AbsenceKind, number> = {
		off: 1,
		vacation: 2,
		holiday: 3,
		sick: 4,
	};
	return priority[next] >= priority[current] ? next : current;
}

// ---------------------------------------------------------------------------
//  ICS Text Parsing
// ---------------------------------------------------------------------------

function unfoldLines(raw: string): string[] {
	const lines: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
			lines[lines.length - 1] += line.slice(1);
		} else {
			lines.push(line);
		}
	}
	return lines;
}

export function parseIcsDate(value: string): string | null {
	const parts = value.split(':');
	const clean = value.includes(':') ? parts[parts.length - 1] : value;
	const digits = clean.replace(/[^0-9]/g, '');

	if (digits.length >= 8) {
		const y = digits.slice(0, 4);
		const m = digits.slice(4, 6);
		const d = digits.slice(6, 8);
		return `${y}-${m}-${d}`;
	}
	return null;
}

function parseRRule(rrule: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const part of rrule.split(';')) {
		const eqIdx = part.indexOf('=');
		if (eqIdx > 0) {
			result[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
		}
	}
	return result;
}

const ICS_DAY_MAP: Record<string, number> = {
	SU: 0,
	MO: 1,
	TU: 2,
	WE: 3,
	TH: 4,
	FR: 5,
	SA: 6,
};

export function parseAbsenceEvents(text: string): AbsenceEvent[] {
	const lines = unfoldLines(text);
	const events: AbsenceEvent[] = [];
	let inEvent = false;
	let summary = '';
	let dtstart = '';
	let dtend = '';
	let status = '';
	let rrule = '';
	let exdates: string[] = [];

	for (const line of lines) {
		if (line === 'BEGIN:VEVENT') {
			inEvent = true;
			summary = '';
			dtstart = '';
			dtend = '';
			status = '';
			rrule = '';
			exdates = [];
			continue;
		}

		if (line === 'END:VEVENT') {
			if (inEvent && dtstart && status !== 'CANCELLED') {
				// Only keep all-day events
				const rawValue = dtstart.includes(':')
					? dtstart.split(':').pop() || ''
					: dtstart;
				const isAllDayByLength = rawValue.replace(/[^0-9]/g, '').length === 8;

				if (isAllDayByLength) {
					events.push({
						summary,
						dtstart,
						dtend: dtend || dtstart,
						rrule,
						exdates,
					});
				}
			}
			inEvent = false;
			continue;
		}

		if (!inEvent) continue;

		if (line.startsWith('SUMMARY')) {
			summary = line.replace(/^SUMMARY[^:]*:/, '');
		} else if (line.startsWith('DTSTART')) {
			dtstart = line.replace(/^DTSTART/, '');
		} else if (line.startsWith('DTEND')) {
			dtend = line.replace(/^DTEND/, '');
		} else if (line.startsWith('STATUS')) {
			status = line.replace(/^STATUS[^:]*:/, '').trim();
		} else if (line.startsWith('RRULE')) {
			rrule = line.replace(/^RRULE:/, '');
		} else if (line.startsWith('EXDATE')) {
			const val = line.replace(/^EXDATE[^:]*:/, '');
			for (const v of val.split(',')) {
				if (v.trim()) exdates.push(v.trim());
			}
		}
	}

	return events;
}

// ---------------------------------------------------------------------------
//  Recurrence Expansion
// ---------------------------------------------------------------------------

export function expandAbsenceDates(
	event: AbsenceEvent,
	rangeStart: string,
	rangeEnd: string,
): { date: string; summary: string }[] {
	const results: { date: string; summary: string }[] = [];

	const startIso = parseIcsDate(event.dtstart);
	const endIso = parseIcsDate(event.dtend);
	if (!startIso) return results;

	// Build excluded dates set
	const exdateSet = new Set<string>();
	for (const exd of event.exdates) {
		const parsed = parseIcsDate(exd);
		if (parsed) exdateSet.add(parsed);
	}

	if (!event.rrule) {
		// Non-recurring: expand date range [startIso, endIso)
		const effectiveEnd = endIso || startIso;
		const cursor = new Date(`${startIso}T00:00:00`);
		const endDate = new Date(`${effectiveEnd}T00:00:00`);

		while (cursor < endDate) {
			const iso = toLocalDateString(cursor);
			if (iso >= rangeStart && iso <= rangeEnd && !exdateSet.has(iso)) {
				results.push({ date: iso, summary: event.summary });
			}
			cursor.setDate(cursor.getDate() + 1);
		}
		return results;
	}

	// Recurring event expansion
	const rule = parseRRule(event.rrule);
	const freq = rule.FREQ;
	const interval = Number.parseInt(rule.INTERVAL || '1', 10);
	const count = rule.COUNT ? Number.parseInt(rule.COUNT, 10) : undefined;

	// Per-occurrence span in days
	let spanDays = 1;
	if (endIso) {
		const startMs = new Date(`${startIso}T00:00:00`).getTime();
		const endMs = new Date(`${endIso}T00:00:00`).getTime();
		const diff = Math.round((endMs - startMs) / 86400000);
		if (diff >= 1) spanDays = diff;
	}

	let untilIso: string | null = null;
	if (rule.UNTIL) {
		untilIso = parseIcsDate(rule.UNTIL);
	}

	// Parse BYDAY (e.g. "MO,WE,FR") for WEEKLY expansion
	const byDay: number[] = [];
	if (rule.BYDAY) {
		for (const dayStr of rule.BYDAY.split(',')) {
			const cleaned = dayStr.trim().replace(/^-?\d+/, '');
			const dayNum = ICS_DAY_MAP[cleaned];
			if (dayNum !== undefined) byDay.push(dayNum);
		}
	}

	const rangeStartDate = new Date(`${rangeStart}T00:00:00`);
	const rangeEndDate = new Date(`${rangeEnd}T23:59:59`);
	const hardLimit = new Date(rangeStartDate);
	hardLimit.setFullYear(hardLimit.getFullYear() + 1);

	const originDate = new Date(`${startIso}T00:00:00`);
	let generated = 0;
	const maxOccurrences = count || 500;

	const addOccurrenceSpan = (occStart: Date) => {
		const dayCursor = new Date(occStart);
		for (let i = 0; i < spanDays; i++) {
			const iso = toLocalDateString(dayCursor);
			if (
				dayCursor >= rangeStartDate &&
				dayCursor <= rangeEndDate &&
				!exdateSet.has(iso)
			) {
				results.push({ date: iso, summary: event.summary });
			}
			dayCursor.setDate(dayCursor.getDate() + 1);
		}
	};

	const pastUntil = (occStart: Date) =>
		untilIso !== null && toLocalDateString(occStart) > untilIso;

	if (freq === 'YEARLY') {
		const cursor = new Date(originDate);
		while (cursor <= rangeEndDate && cursor <= hardLimit) {
			if (pastUntil(cursor)) break;
			if (generated >= maxOccurrences) break;
			generated++;
			addOccurrenceSpan(cursor);
			cursor.setFullYear(cursor.getFullYear() + interval);
		}
	} else if (freq === 'MONTHLY') {
		const cursor = new Date(originDate);
		while (cursor <= rangeEndDate && cursor <= hardLimit) {
			if (pastUntil(cursor)) break;
			if (generated >= maxOccurrences) break;
			generated++;
			addOccurrenceSpan(cursor);
			cursor.setMonth(cursor.getMonth() + interval);
		}
	} else if (freq === 'WEEKLY') {
		const effectiveDays = byDay.length > 0 ? byDay : [originDate.getDay()];
		const weekCursor = new Date(originDate);
		weekCursor.setDate(weekCursor.getDate() - weekCursor.getDay());

		while (weekCursor <= rangeEndDate && weekCursor <= hardLimit) {
			if (generated >= maxOccurrences) break;
			for (const targetDay of effectiveDays) {
				const occStart = new Date(weekCursor);
				occStart.setDate(weekCursor.getDate() + targetDay);
				if (occStart < originDate) continue;
				if (pastUntil(occStart)) continue;
				if (generated >= maxOccurrences) break;
				generated++;
				addOccurrenceSpan(occStart);
			}
			if (untilIso !== null && toLocalDateString(weekCursor) > untilIso) {
				const weekEnd = new Date(weekCursor);
				weekEnd.setDate(weekEnd.getDate() + 6);
				if (toLocalDateString(weekEnd) > untilIso) break;
			}
			weekCursor.setDate(weekCursor.getDate() + 7 * interval);
		}
	} else if (freq === 'DAILY') {
		const cursor = new Date(originDate);
		while (cursor <= rangeEndDate && cursor <= hardLimit) {
			if (pastUntil(cursor)) break;
			if (generated >= maxOccurrences) break;
			generated++;
			addOccurrenceSpan(cursor);
			cursor.setDate(cursor.getDate() + interval);
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
//  Absence merging
// ---------------------------------------------------------------------------

/**
 * Merge parsed events into a map of email → date → NormalizedAbsenceDay,
 * matching the shape the frontend expects and the DB table stores.
 */
export function mergeAbsenceResults(
	entries: { email: string; date: string; summary: string; kind: AbsenceKind }[],
): Map<string, Map<string, NormalizedAbsenceDay>> {
	const userDays = new Map<string, Map<string, NormalizedAbsenceDay>>();

	for (const entry of entries) {
		const email = entry.email.trim().toLowerCase();
		if (!email) continue;

		let userDates = userDays.get(email);
		if (!userDates) {
			userDates = new Map();
			userDays.set(email, userDates);
		}

		const existing = userDates.get(entry.date);
		if (existing) {
			existing.kind = resolveAbsenceKind(existing.kind, entry.kind);
			// Keep the more informative summary (longer wins)
			if (entry.summary.length > existing.summary.length) {
				existing.summary = entry.summary;
			}
		} else {
			userDates.set(entry.date, {
				date: entry.date,
				summary: entry.summary,
				kind: entry.kind,
			});
		}
	}

	return userDays;
}

// ---------------------------------------------------------------------------
//  Main entry point: fetch + parse + expand
// ---------------------------------------------------------------------------

export interface ProcessFeedResult {
	feedUrl: string;
	feedType: 'absence' | 'holiday';
	label: string;
	absenceAttribution: 'self' | 'shared' | null;
	titleFilter: string | null;
	events: AbsenceEvent[];
}

/**
 * Fetch an ICS feed and parse the events from it.
 * Returns null if the fetch or parse fails.
 */
export async function fetchAndParseFeed(
	url: string,
	signal?: AbortSignal,
): Promise<{ events: AbsenceEvent[] } | null> {
	try {
		const res = await fetch(url, { signal });
		if (!res.ok) return null;
		const text = await res.text();
		return { events: parseAbsenceEvents(text) };
	} catch {
		return null;
	}
}

/**
 * Given a processed feed result and assignment info, expand events into
 * absence-day entries for specific user emails.
 */
export function expandFeedForUsers(
	feed: ProcessFeedResult,
	rangeStart: string,
	rangeEnd: string,
	feedOwnerEmail: string,
	assignments: { pattern: string; userEmails: string[] }[],
): { email: string; date: string; summary: string; kind: AbsenceKind }[] {
	const results: { email: string; date: string; summary: string; kind: AbsenceKind }[] = [];

	if (feed.feedType === 'holiday') {
		for (const event of feed.events) {
			if (feed.titleFilter && !event.summary.toLowerCase().includes(feed.titleFilter.toLowerCase())) continue;

			const dates = expandAbsenceDates(event, rangeStart, rangeEnd);

			// Check for regional/assignment-scoped holidays
			const regionalUsers: string[] = [];
			for (const assignment of assignments) {
				if (event.summary.toLowerCase().includes(assignment.pattern.toLowerCase())) {
					for (const email of assignment.userEmails) {
						regionalUsers.push(email);
					}
				}
			}

			if (regionalUsers.length > 0) {
				for (const { date, summary } of dates) {
					const reason = feed.label ? `[${feed.label}] ${summary}` : summary;
					for (const email of regionalUsers) {
						results.push({ email, date, summary: reason, kind: 'holiday' });
					}
				}
			} else {
				// Nationwide holiday — applies to every user
				// (caller is responsible for fanning out; we return with email='*' for
				// nationwide items, which the caller expands to all known user emails)
				for (const { date, summary } of dates) {
					const reason = feed.label ? `[${feed.label}] ${summary}` : summary;
					results.push({ email: '*', date, summary: reason, kind: 'holiday' });
				}
			}
		}
	} else {
		// Absence feed
		const attribution = feed.absenceAttribution ?? 'self';
		const labelPrefix = feed.label ? `[${feed.label}] ` : '';

		for (const event of feed.events) {
			if (feed.titleFilter && !event.summary.toLowerCase().includes(feed.titleFilter.toLowerCase())) continue;

			const dates = expandAbsenceDates(event, rangeStart, rangeEnd);
			const kind = classifyAbsenceKind(event.summary);

			if (attribution === 'shared') {
				// Shared absence: match summary against assignment patterns
				const matchedEmails: string[] = [];
				for (const assignment of assignments) {
					if (event.summary.toLowerCase().includes(assignment.pattern.toLowerCase())) {
						for (const email of assignment.userEmails) {
							matchedEmails.push(email);
						}
					}
				}
				if (matchedEmails.length === 0) continue; // unmatched shared events are silently ignored

				for (const { date, summary } of dates) {
					const reason = `${labelPrefix}${summary}`;
					for (const email of matchedEmails) {
						results.push({ email, date, summary: reason, kind });
					}
				}
			} else {
				// Self attribution — applies to feed owner
				for (const { date, summary } of dates) {
					const reason = `${labelPrefix}${summary}`;
					results.push({ email: feedOwnerEmail, date, summary: reason, kind });
				}
			}
		}
	}

	return results;
}
