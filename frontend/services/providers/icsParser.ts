import { toLocalDateString } from '../../react/utils/date';
import type {
  CalendarParser,
  DateEntry,
  ParsedCalendarEvent,
} from './types';

/**
 * ICS parsing utilities — lightweight re-implementation of the subset needed
 * for absence detection (all-day events only).
 */

/** Unfold RFC 5545 line continuations (lines starting with space/tab). */
export function unfoldLines(raw: string): string[] {
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
 * Parse an ICS DATE or DATE-TIME value into a YYYY-MM-DD string.
 * Returns null when the value doesn't contain at least 8 digits.
 */
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

/** Parse an RRULE property value into a key→value map. */
export function parseRRule(rrule: string): Record<string, string> {
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
 * Parse an ICS feed string into a list of all-day ParsedCalendarEvents.
 * Skips CANCELLED events and non-all-day VEVENT blocks.
 */
export function parseIcsEvents(text: string): ParsedCalendarEvent[] {
  const lines = unfoldLines(text);
  const events: ParsedCalendarEvent[] = [];
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
        // Only keep all-day events (VALUE=DATE or 8-digit dates without T)
        const isAllDay =
          line.includes('VALUE=DATE') ||
          dtstart.length <= 8 ||
          dtstart.includes('VALUE=DATE');
        // Check the raw dtstart for all-day pattern
        const rawValue = dtstart.includes(':')
          ? dtstart.split(':').pop() || ''
          : dtstart;
        const isAllDayByLength = rawValue.replace(/[^0-9]/g, '').length === 8;

        if (isAllDay || isAllDayByLength) {
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

/**
 * Expand all-day events into individual date strings within [rangeStart, rangeEnd].
 * For multi-day events (dtstart != dtend), generates each intermediate day.
 * For recurring events, expands DAILY/WEEKLY/MONTHLY/YEARLY patterns.
 */
export function expandIcsEventDates(
  event: ParsedCalendarEvent,
  rangeStart: string,
  rangeEnd: string,
): DateEntry[] {
  const results: DateEntry[] = [];

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
    // ICS all-day DTEND is exclusive (next day after last day)
    const effectiveEnd = endIso || startIso;
    const cursor = new Date(`${startIso}T00:00:00`);
    const endDate = new Date(`${effectiveEnd}T00:00:00`);

    while (cursor < endDate) {
      const iso = toLocalDateString(cursor);
      if (iso >= rangeStart && iso <= rangeEnd && !exdateSet.has(iso)) {
        // Weekends are kept too — they have a zero target so they
        // don't change compliance %, but they remain visible on the
        // calendar/heatmap (e.g. sick day that spans Sat–Mon).
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

  // Per-occurrence span in days. ICS all-day DTEND is exclusive, so a single
  // day has DTEND = DTSTART + 1 → span 1. Multi-day vacations carry their full
  // duration into every recurrence (ADA-462a).
  let spanDays = 1;
  if (endIso) {
    const startMs = new Date(`${startIso}T00:00:00`).getTime();
    const endMs = new Date(`${endIso}T00:00:00`).getTime();
    const diff = Math.round((endMs - startMs) / 86400000);
    if (diff >= 1) spanDays = diff;
  }

  // UNTIL: reduce to a local calendar day so the comparison stays local↔local
  // regardless of whether the ICS UNTIL was a UTC DATE-TIME (…Z) or a DATE
  // (ADA-462c). The final occurrence is inclusive of the UNTIL day.
  let untilIso: string | null = null;
  if (rule.UNTIL) {
    untilIso = parseIcsDate(rule.UNTIL);
  }

  // Parse BYDAY (e.g. "MO,WE,FR") for WEEKLY expansion (ADA-462b).
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

  // Emit each day of an occurrence's [start, start+spanDays) range that falls
  // inside the requested window. `occStart` is the occurrence's first day.
  const addOccurrenceSpan = (occStart: Date) => {
    const dayCursor = new Date(occStart);
    for (let i = 0; i < spanDays; i++) {
      const iso = toLocalDateString(dayCursor);
      if (
        dayCursor >= rangeStartDate &&
        dayCursor <= rangeEndDate &&
        !exdateSet.has(iso)
      ) {
        // Weekends kept (see expansion of non-recurring events above).
        results.push({ date: iso, summary: event.summary });
      }
      dayCursor.setDate(dayCursor.getDate() + 1);
    }
  };

  // An occurrence counts (against COUNT/UNTIL) by its start day; spanning is
  // applied afterwards. `pastUntil` checks the occurrence start day against the
  // UNTIL day, both as local calendar dates.
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
    // Honor BYDAY: emit each listed weekday within each `interval`-week block.
    // Without BYDAY, fall back to the origin weekday.
    const effectiveDays = byDay.length > 0 ? byDay : [originDate.getDay()];
    // Align the week cursor to the start of the origin week (Sunday).
    const weekCursor = new Date(originDate);
    weekCursor.setDate(weekCursor.getDate() - weekCursor.getDay());

    while (weekCursor <= rangeEndDate && weekCursor <= hardLimit) {
      if (generated >= maxOccurrences) break;
      for (const targetDay of effectiveDays) {
        const occStart = new Date(weekCursor);
        occStart.setDate(weekCursor.getDate() + targetDay);
        // Skip days before the actual start, and stop past UNTIL.
        if (occStart < originDate) continue;
        if (pastUntil(occStart)) continue;
        if (generated >= maxOccurrences) break;
        generated++;
        addOccurrenceSpan(occStart);
      }
      if (untilIso !== null && toLocalDateString(weekCursor) > untilIso) {
        // Whole week is past UNTIL — no later week can qualify.
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

/**
 * ICS-based CalendarParser — used for both absence and holiday feeds.
 */
export const icsParser: CalendarParser = {
  parse: parseIcsEvents,
  expand: expandIcsEventDates,
};
