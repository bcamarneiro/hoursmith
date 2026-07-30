/**
 * Parsed calendar event — the raw shape extracted from an ICS VEVENT block.
 * The parser produces these; the caller expands them into individual dates.
 */
export interface ParsedCalendarEvent {
  summary: string;
  dtstart: string;
  dtend: string;
  rrule: string;
  exdates: string[];
}

/** A single date → summary pair produced by event expansion. */
export interface DateEntry {
  date: string;
  summary: string;
}

/**
 * CalendarParser is the interface every feed-type parser must implement.
 * - `parse` turns a raw ICS string into structured events.
 * - `expand` fans out a single event into concrete calendar dates within a range.
 */
export interface CalendarParser {
  parse(raw: string): ParsedCalendarEvent[];
  expand(
    event: ParsedCalendarEvent,
    rangeStart: string,
    rangeEnd: string,
  ): DateEntry[];
}

/** Feed types supported by the parser factory. */
export type FeedType = 'absence' | 'holiday';
