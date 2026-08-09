import { expandIcsEventDates } from './icsParser';
import type { CalendarParser, ParsedCalendarEvent } from './types';

/**
 * Internal shape expected from the JSON payload.
 * Dates are in YYYY-MM-DD format. rrule and exdates are optional.
 */
interface JsonCalendarEvent {
  summary: string;
  dtstart: string;
  dtend: string;
  rrule?: string;
  exdates?: string[];
}

/**
 * Parse a JSON payload of calendar events into ParsedCalendarEvent[].
 *
 * Expected JSON format (an array of events):
 * ```json
 * [
 *   {
 *     "summary": "Vacation",
 *     "dtstart": "2026-04-07",
 *     "dtend": "2026-04-08",
 *     "rrule": "FREQ=WEEKLY;COUNT=2",
 *     "exdates": ["2026-06-03"]
 *   }
 * ]
 * ```
 *
 * - `dtstart` / `dtend`: required, YYYY-MM-DD
 * - `summary`: required, non-empty string
 * - `rrule`: optional ICS recurrence string
 * - `exdates`: optional array of YYYY-MM-DD exclusion dates
 *
 * Events with missing or invalid date fields are skipped.
 */
export function parseJsonEvents(raw: string): ParsedCalendarEvent[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    // If the payload isn't valid JSON, return no events (defensive).
    return [];
  }

  if (!Array.isArray(parsed)) {
    // Single objects are tolerated but wrapped
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return [normalizeEvent(parsed as Record<string, unknown>)].filter(
        (e): e is ParsedCalendarEvent => e !== null,
      );
    }
    return [];
  }

  const events: ParsedCalendarEvent[] = [];
  for (const item of parsed) {
    if (item && typeof item === 'object') {
      const normalized = normalizeEvent(item as Record<string, unknown>);
      if (normalized) {
        events.push(normalized);
      }
    }
  }
  return events;
}

/**
 * Normalize a raw JSON object into a ParsedCalendarEvent, or null if invalid.
 */
function normalizeEvent(
  raw: Record<string, unknown>,
): ParsedCalendarEvent | null {
  const summary =
    typeof raw.summary === 'string' ? raw.summary.trim() : '';

  const dtstart =
    typeof raw.dtstart === 'string' ? raw.dtstart.trim() : '';

  const dtend =
    typeof raw.dtend === 'string' ? raw.dtend.trim() : '';

  // Both summary and start date are required.
  if (!summary || !dtstart || !dtend) return null;

  const rrule =
    typeof raw.rrule === 'string' ? raw.rrule.trim() : '';

  let exdates: string[] = [];
  if (Array.isArray(raw.exdates)) {
    exdates = raw.exdates
      .map((d) => (typeof d === 'string' ? d.trim() : ''))
      .filter(Boolean);
  }

  return { summary, dtstart, dtend, rrule, exdates };
}

/**
 * Expand a single parsed JSON calendar event into individual dates.
 * Reuses the ICS expansion logic since the shape is the same.
 */
export function expandJsonEventDates(
  event: ParsedCalendarEvent,
  rangeStart: string,
  rangeEnd: string,
) {
  return expandIcsEventDates(event, rangeStart, rangeEnd);
}

/**
 * JSON-based CalendarParser — for feeds that provide events as JSON arrays.
 */
export const jsonParser: CalendarParser = {
  parse: parseJsonEvents,
  expand: expandJsonEventDates,
};
