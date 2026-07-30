import { icsParser } from './icsParser';
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
