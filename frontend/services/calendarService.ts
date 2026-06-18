import type { WorklogSuggestion } from '../../types/Suggestion';
import { toLocalDateString } from '../react/utils/date';
import { logger } from '../react/utils/logger';
import type { CalendarFeed } from '../stores/useConfigStore';
import type { CalendarMapping } from '../stores/useUserDataStore';
import { fromHttpResponse } from './serviceErrors';

const JIRA_KEY_RE = /([A-Z][A-Z0-9]+-\d+)/g;

interface CalendarEvent {
	summary: string;
	description: string;
	dtstart: string; // raw ICS value
	dtend: string;
	status: string; // e.g. CONFIRMED, TENTATIVE, CANCELLED
	rrule: string; // raw RRULE value, empty if not recurring
	exdates: string[]; // EXDATE values (excluded occurrences)
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === 'AbortError') ||
		(error instanceof Error && error.name === 'AbortError')
	);
}

function matchesTitleFilter(summary: string, titleFilter?: string): boolean {
	if (!titleFilter?.trim()) return true;
	return summary.toLowerCase().includes(titleFilter.trim().toLowerCase());
}

function extractJiraKeys(text: string): string[] {
	const matches = text.match(JIRA_KEY_RE);
	return matches ? [...new Set(matches)] : [];
}

/**
 * Find issue key from stored calendar mappings.
 * Returns the first mapping whose pattern matches the event summary
 * (case-insensitive substring match).
 */
function findMappedIssueKey(
	summary: string,
	mappings: CalendarMapping[],
): CalendarMapping | null {
	const lower = summary.toLowerCase();
	for (const mapping of mappings) {
		for (const pattern of mapping.patterns) {
			if (pattern && lower.includes(pattern.toLowerCase())) {
				return mapping;
			}
		}
	}
	return null;
}

/**
 * Unfold ICS lines: continuation lines (starting with space/tab) are joined
 * to their preceding line.
 */
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

/**
 * Parse an ICS date/datetime value into an ISO date string (YYYY-MM-DD)
 * and a Date object.
 *
 * Handles formats:
 *   20260316              (all-day)
 *   20260316T090000Z      (UTC)
 *   20260316T090000       (local / floating)
 */
function parseIcsDateTime(value: string): { iso: string; date: Date } | null {
	// Strip any TZID= prefix — the value is after the last colon
	const parts = value.split(':');
	const clean = value.includes(':') ? parts[parts.length - 1] : value;
	const digits = clean.replace(/[^0-9TZ]/g, '');

	if (digits.length === 8) {
		// All-day: YYYYMMDD
		const y = digits.slice(0, 4);
		const m = digits.slice(4, 6);
		const d = digits.slice(6, 8);
		return {
			iso: `${y}-${m}-${d}`,
			date: new Date(`${y}-${m}-${d}T00:00:00`),
		};
	}

	if (digits.length >= 15) {
		const y = digits.slice(0, 4);
		const m = digits.slice(4, 6);
		const d = digits.slice(6, 8);
		const hh = digits.slice(9, 11);
		const mm = digits.slice(11, 13);
		const ss = digits.slice(13, 15);
		const isUtc = clean.endsWith('Z');
		const isoStr = `${y}-${m}-${d}T${hh}:${mm}:${ss}${isUtc ? 'Z' : ''}`;
		const date = new Date(isoStr);
		// Day attribution (ADA-463): for a UTC-stamped time the raw digits name
		// the UTC day, but the user worked it on their *local* calendar day. A
		// 23:00Z event is already "tomorrow" for a UTC+ user and "still today"
		// shifted for UTC- users. Derive `iso` from the parsed Date in local TZ
		// so the consumer's week filter sees the right day. Floating/local times
		// have no offset, so local conversion is a no-op for them.
		const iso = Number.isNaN(date.getTime())
			? `${y}-${m}-${d}`
			: toLocalDateString(date);
		return { iso, date };
	}

	return null;
}

/**
 * Parse RRULE string into key-value pairs.
 * e.g. "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2" → { FREQ: "WEEKLY", BYDAY: "MO,WE", INTERVAL: "2" }
 */
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

/**
 * Expand a recurring event into individual occurrences within [rangeStart, rangeEnd].
 * Supports FREQ=DAILY, WEEKLY (with BYDAY), MONTHLY.
 * Handles UNTIL, COUNT, INTERVAL, and EXDATE.
 */
function expandRecurring(
	event: CalendarEvent,
	rangeStart: string,
	rangeEnd: string,
): CalendarEvent[] {
	if (!event.rrule) return [event];

	const startParsed = parseIcsDateTime(event.dtstart);
	const endParsed = parseIcsDateTime(event.dtend);
	if (!startParsed) return [event];

	const durationMs = endParsed
		? endParsed.date.getTime() - startParsed.date.getTime()
		: 3600000; // default 1h

	const rule = parseRRule(event.rrule);
	const freq = rule.FREQ;
	const interval = Number.parseInt(rule.INTERVAL || '1', 10);
	const count = rule.COUNT ? Number.parseInt(rule.COUNT, 10) : undefined;

	let until: Date | null = null;
	if (rule.UNTIL) {
		const parsed = parseIcsDateTime(rule.UNTIL);
		if (parsed) until = parsed.date;
	}

	// Parse BYDAY for WEEKLY frequency (e.g. "MO,WE,FR")
	const byDay: number[] = [];
	if (rule.BYDAY) {
		for (const dayStr of rule.BYDAY.split(',')) {
			// Strip ordinal prefix (e.g. "1MO" → "MO") for monthly BYDAY
			const cleaned = dayStr.replace(/^-?\d+/, '');
			const dayNum = ICS_DAY_MAP[cleaned];
			if (dayNum !== undefined) byDay.push(dayNum);
		}
	}

	// Build excluded dates set (ISO date strings)
	const exdateSet = new Set<string>();
	for (const exd of event.exdates) {
		const parsed = parseIcsDateTime(exd);
		if (parsed) exdateSet.add(parsed.iso);
	}

	const rangeStartDate = new Date(`${rangeStart}T00:00:00`);
	const rangeEndDate = new Date(`${rangeEnd}T23:59:59`);
	// Don't generate occurrences indefinitely — cap at 1 year from range start
	const hardLimit = new Date(rangeStartDate);
	hardLimit.setFullYear(hardLimit.getFullYear() + 1);

	const occurrences: CalendarEvent[] = [];
	const originDate = new Date(startParsed.date);
	let generated = 0;
	const maxOccurrences = count || 1000; // safety cap

	if (freq === 'WEEKLY') {
		// For WEEKLY: advance by `interval` weeks, check BYDAY
		const effectiveDays = byDay.length > 0 ? byDay : [originDate.getDay()];

		// Start from the origin week, advance until past range
		const cursor = new Date(originDate);
		// Align to start of week (Sunday)
		cursor.setDate(cursor.getDate() - cursor.getDay());

		while (cursor <= rangeEndDate && cursor <= hardLimit) {
			if (until && cursor > until) break;
			if (generated >= maxOccurrences) break;

			for (const targetDay of effectiveDays) {
				const occurrence = new Date(cursor);
				occurrence.setDate(cursor.getDate() + targetDay);

				// Must be on or after the original start
				if (occurrence < originDate) continue;
				if (until && occurrence > until) continue;
				if (generated >= maxOccurrences) break;

				generated++;
				const iso = toLocalDateString(occurrence);

				if (occurrence < rangeStartDate || occurrence > rangeEndDate) continue;
				if (exdateSet.has(iso)) continue;

				// Build dtstart/dtend preserving time-of-day
				const timeStr = event.dtstart.includes('T')
					? event.dtstart.slice(event.dtstart.indexOf('T'))
					: '';
				const endTimeStr = event.dtend.includes('T')
					? event.dtend.slice(event.dtend.indexOf('T'))
					: '';
				const ymd = iso.replace(/-/g, '');

				const endDate = new Date(occurrence.getTime() + durationMs);
				const endYmd = toLocalDateString(endDate).replace(/-/g, '');

				occurrences.push({
					...event,
					dtstart: `${ymd}${timeStr}`,
					dtend: `${endYmd}${endTimeStr}`,
					rrule: '', // mark as expanded
				});
			}

			// Advance by interval weeks
			cursor.setDate(cursor.getDate() + 7 * interval);
		}
	} else if (freq === 'DAILY') {
		const cursor = new Date(originDate);

		while (cursor <= rangeEndDate && cursor <= hardLimit) {
			if (until && cursor > until) break;
			if (generated >= maxOccurrences) break;

			generated++;
			const iso = toLocalDateString(cursor);

			if (cursor >= rangeStartDate && cursor <= rangeEndDate) {
				if (!exdateSet.has(iso)) {
					const ymd = iso.replace(/-/g, '');
					const timeStr = event.dtstart.includes('T')
						? event.dtstart.slice(event.dtstart.indexOf('T'))
						: '';
					const endDate = new Date(cursor.getTime() + durationMs);
					const endYmd = toLocalDateString(endDate).replace(/-/g, '');
					const endTimeStr = event.dtend.includes('T')
						? event.dtend.slice(event.dtend.indexOf('T'))
						: '';

					occurrences.push({
						...event,
						dtstart: `${ymd}${timeStr}`,
						dtend: `${endYmd}${endTimeStr}`,
						rrule: '',
					});
				}
			}

			cursor.setDate(cursor.getDate() + interval);
		}
	} else if (freq === 'MONTHLY') {
		const cursor = new Date(originDate);

		while (cursor <= rangeEndDate && cursor <= hardLimit) {
			if (until && cursor > until) break;
			if (generated >= maxOccurrences) break;

			generated++;
			const iso = toLocalDateString(cursor);

			if (cursor >= rangeStartDate && cursor <= rangeEndDate) {
				if (!exdateSet.has(iso)) {
					const ymd = iso.replace(/-/g, '');
					const timeStr = event.dtstart.includes('T')
						? event.dtstart.slice(event.dtstart.indexOf('T'))
						: '';
					const endDate = new Date(cursor.getTime() + durationMs);
					const endYmd = toLocalDateString(endDate).replace(/-/g, '');
					const endTimeStr = event.dtend.includes('T')
						? event.dtend.slice(event.dtend.indexOf('T'))
						: '';

					occurrences.push({
						...event,
						dtstart: `${ymd}${timeStr}`,
						dtend: `${endYmd}${endTimeStr}`,
						rrule: '',
					});
				}
			}

			cursor.setMonth(cursor.getMonth() + interval);
		}
	} else {
		// Unsupported frequency — return original event
		return [event];
	}

	return occurrences;
}

/**
 * Parse VEVENT blocks from ICS text.
 */
function parseIcs(text: string): CalendarEvent[] {
	const lines = unfoldLines(text);
	const events: CalendarEvent[] = [];
	let inEvent = false;
	let summary = '';
	let description = '';
	let dtstart = '';
	let dtend = '';
	let status = '';
	let rrule = '';
	let exdates: string[] = [];

	for (const line of lines) {
		if (line === 'BEGIN:VEVENT') {
			inEvent = true;
			summary = '';
			description = '';
			dtstart = '';
			dtend = '';
			status = '';
			rrule = '';
			exdates = [];
			continue;
		}

		if (line === 'END:VEVENT') {
			// Skip cancelled events
			if (inEvent && dtstart && status !== 'CANCELLED') {
				events.push({
					summary,
					description,
					dtstart,
					dtend: dtend || dtstart,
					status,
					rrule,
					exdates,
				});
			}
			inEvent = false;
			continue;
		}

		if (!inEvent) continue;

		// Property value — handle parameters (e.g. DTSTART;TZID=...:value)
		if (line.startsWith('SUMMARY')) {
			summary = line.replace(/^SUMMARY[^:]*:/, '');
		} else if (line.startsWith('DESCRIPTION')) {
			description = line
				.replace(/^DESCRIPTION[^:]*:/, '')
				.replace(/\\n/g, ' ')
				.replace(/\\,/g, ',');
		} else if (line.startsWith('DTSTART')) {
			dtstart = line.replace(/^DTSTART[^:]*:/, '');
		} else if (line.startsWith('DTEND')) {
			dtend = line.replace(/^DTEND[^:]*:/, '');
		} else if (line.startsWith('STATUS')) {
			status = line.replace(/^STATUS[^:]*:/, '').trim();
		} else if (line.startsWith('RRULE')) {
			rrule = line.replace(/^RRULE:/, '');
		} else if (line.startsWith('EXDATE')) {
			// EXDATE can have multiple values comma-separated, or multiple EXDATE lines
			const val = line.replace(/^EXDATE[^:]*:/, '');
			for (const v of val.split(',')) {
				if (v.trim()) exdates.push(v.trim());
			}
		}
	}

	return events;
}

/**
 * Fetch a single ICS feed and return parsed events within the date range.
 */
async function fetchFeed(
	feedUrl: string,
	corsProxy: string,
	signal?: AbortSignal,
): Promise<CalendarEvent[]> {
	const url = corsProxy
		? `${corsProxy.replace(/\/$/, '')}/${feedUrl}`
		: feedUrl;

	const res = await fetch(url, { signal });
	if (!res.ok) {
		throw fromHttpResponse('Calendar feed', res.status);
	}

	const icsText = await res.text();
	return parseIcs(icsText);
}

interface GroupedEvent {
	totalSeconds: number;
	reasons: string[];
	eventCount: number;
	/** Set for unmapped events — the raw event title */
	eventTitle?: string;
}

/**
 * Fetch multiple ICS calendar feeds in parallel and build worklog suggestions.
 *
 * Events are resolved in this order:
 * 1. Jira keys found in event title/description (inline keys)
 * 2. Stored calendar mappings (pattern → issueKey)
 * 3. Unmapped events: returned with empty issueKey so the UI can show
 *    a "Map to Issue" action
 *
 * Recurring events (RRULE) are expanded into individual occurrences
 * within the requested date range.
 */
export async function fetchCalendarSuggestions(
	feeds: CalendarFeed[],
	corsProxy: string,
	weekStart: string,
	weekEnd: string,
	mappings: CalendarMapping[],
	signal?: AbortSignal,
): Promise<WorklogSuggestion[]> {
	if (feeds.length === 0) return [];

	// Fetch all feeds in parallel; skip individual failures
	const results = await Promise.allSettled(
		feeds.map((feed) =>
			fetchFeed(feed.url, corsProxy, signal).then((events) => ({
				label: feed.label,
				titleFilter: feed.titleFilter,
				events,
			})),
		),
	);

	const allEvents: { label: string; event: CalendarEvent }[] = [];
	for (const result of results) {
		if (result.status === 'fulfilled') {
			let expandedCount = 0;
			for (const event of result.value.events) {
				if (!matchesTitleFilter(event.summary, result.value.titleFilter)) {
					continue;
				}
				// Expand recurring events into individual occurrences
				const occurrences = expandRecurring(event, weekStart, weekEnd);
				expandedCount += occurrences.length;
				for (const occ of occurrences) {
					allEvents.push({ label: result.value.label, event: occ });
				}
			}
			logger.debug(
				`[Calendar] Feed "${result.value.label}": ${result.value.events.length} events, ${expandedCount} after expanding recurrences`,
			);
		} else {
			if (!isAbortError(result.reason)) {
				logger.warn('[Calendar] Feed failed:', result.reason);
			}
		}
	}

	if (signal?.aborted) {
		return [];
	}

	logger.debug(
		`[Calendar] Total events: ${allEvents.length}, weekStart=${weekStart}, weekEnd=${weekEnd}`,
	);

	// Group mapped events by (date, issueKey)
	const grouped = new Map<string, GroupedEvent>();
	// Collect unmapped events separately, grouped by (date, eventTitle)
	const unmapped = new Map<string, GroupedEvent>();

	let skippedNoParse = 0;
	let skippedOutOfRange = 0;
	let skippedAllDay = 0;

	for (const { label, event } of allEvents) {
		const start = parseIcsDateTime(event.dtstart);
		const end = parseIcsDateTime(event.dtend);
		if (!start) {
			skippedNoParse++;
			logger.warn(
				`[Calendar] Could not parse DTSTART: "${event.dtstart}" for "${event.summary}"`,
			);
			continue;
		}

		const day = start.iso;
		if (day < weekStart || day > weekEnd) {
			skippedOutOfRange++;
			continue;
		}

		// Skip all-day events (likely OOO, holidays, birthdays)
		const isAllDay = event.dtstart.length <= 8;
		if (isAllDay) {
			skippedAllDay++;
			continue;
		}

		// Duration in seconds from event times
		let durationSeconds = 0;
		if (end) {
			durationSeconds = Math.max(
				0,
				(end.date.getTime() - start.date.getTime()) / 1000,
			);
		}
		// Cap individual event at 4h, min 15m
		durationSeconds = Math.max(900, Math.min(durationSeconds, 4 * 3600));

		const prefix = label ? `[${label}] ` : '';
		const allText = `${event.summary} ${event.description}`;

		// 1. Try inline Jira keys
		const inlineKeys = extractJiraKeys(allText);

		if (inlineKeys.length > 0) {
			for (const key of inlineKeys) {
				const mapKey = `${day}::${key}`;
				const existing = grouped.get(mapKey) || {
					totalSeconds: 0,
					reasons: [],
					eventCount: 0,
				};
				existing.totalSeconds += durationSeconds;
				existing.eventCount++;
				existing.reasons.push(`${prefix}${event.summary.slice(0, 60)}`);
				grouped.set(mapKey, existing);
			}
			continue;
		}

		// 2. Try stored mappings
		const mapping = findMappedIssueKey(event.summary, mappings);
		if (mapping) {
			const mapKey = `${day}::${mapping.issueKey}`;
			const existing = grouped.get(mapKey) || {
				totalSeconds: 0,
				reasons: [],
				eventCount: 0,
			};
			existing.totalSeconds += durationSeconds;
			existing.eventCount++;
			existing.reasons.push(`${prefix}${event.summary.slice(0, 60)}`);
			grouped.set(mapKey, existing);
			continue;
		}

		// 3. Unmapped event — group by (date, eventTitle) for dedup
		const title = event.summary.trim();
		if (!title) continue;

		const unmappedKey = `${day}::${title}`;
		const existingUnmapped = unmapped.get(unmappedKey) || {
			totalSeconds: 0,
			reasons: [],
			eventCount: 0,
			eventTitle: title,
		};
		existingUnmapped.totalSeconds += durationSeconds;
		existingUnmapped.eventCount++;
		existingUnmapped.reasons.push(`${prefix}${title.slice(0, 60)}`);
		unmapped.set(unmappedKey, existingUnmapped);
	}

	const suggestions: WorklogSuggestion[] = [];

	// Build mapped suggestions
	for (const [mapKey, data] of grouped) {
		const [day, issueKey] = mapKey.split('::');
		const cappedSeconds = Math.min(data.totalSeconds, 6 * 3600);
		const hours = cappedSeconds / 3600;

		suggestions.push({
			id: `calendar-${issueKey}-${day}`,
			source: 'calendar',
			issueKey,
			date: day,
			suggestedTimeSpent:
				hours >= 1
					? `${Math.floor(hours)}h${hours % 1 >= 0.5 ? ' 30m' : ''}`
					: '30m',
			suggestedSeconds: cappedSeconds,
			confidence: data.eventCount >= 2 ? 'high' : 'medium',
			reason: `${data.eventCount} calendar event${data.eventCount > 1 ? 's' : ''}: ${data.reasons.slice(0, 2).join('; ')}${data.reasons.length > 2 ? '...' : ''}`,
			logged: false,
		});
	}

	// Build unmapped suggestions (empty issueKey, with calendarEventTitle)
	for (const [mapKey, data] of unmapped) {
		const [day] = mapKey.split('::');
		const cappedSeconds = Math.min(data.totalSeconds, 6 * 3600);
		const hours = cappedSeconds / 3600;
		const title = data.eventTitle || 'Unknown event';

		suggestions.push({
			id: `calendar-unmapped-${day}-${title.slice(0, 30).replace(/\s+/g, '-').toLowerCase()}`,
			source: 'calendar',
			issueKey: '',
			date: day,
			suggestedTimeSpent:
				hours >= 1
					? `${Math.floor(hours)}h${hours % 1 >= 0.5 ? ' 30m' : ''}`
					: '30m',
			suggestedSeconds: cappedSeconds,
			confidence: 'low',
			reason: `${data.eventCount} calendar event${data.eventCount > 1 ? 's' : ''}: ${data.reasons.slice(0, 2).join('; ')}${data.reasons.length > 2 ? '...' : ''}`,
			logged: false,
			calendarEventTitle: title,
		});
	}

	logger.debug(
		`[Calendar] Summary: ${allEvents.length} total, ${skippedNoParse} unparseable, ${skippedOutOfRange} out-of-range, ${skippedAllDay} all-day, ${grouped.size} mapped, ${unmapped.size} unmapped → ${suggestions.length} suggestions`,
	);

	return suggestions;
}
