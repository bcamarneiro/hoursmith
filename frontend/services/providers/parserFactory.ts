import { icsParser } from './icsParser';
import { jsonParser } from './jsonParser';
import type { CalendarParser, FeedType } from './types';

/**
 * Create a CalendarParser for the given feed type.
 * Currently uses the same ICS parser for both 'absence' and 'holiday'
 * feeds — the factory boundary exists to allow swapping in feed-type-
 * specific parsers in the future (e.g. a GCal JSON parser).
 */
export function createCalendarParser(_feedType: FeedType): CalendarParser {
  return icsParser;
}

/**
 * Auto-detect the parser to use based on the raw payload content.
 * - JSON arrays/objects → jsonParser
 * - Anything else (including BEGIN:VCALENDAR, ambiguous, or empty) → icsParser
 */
export function detectParser(raw: string): CalendarParser {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return jsonParser;
  }
  return icsParser;
}
