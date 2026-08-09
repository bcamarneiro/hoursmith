import { describe, expect, it } from 'vitest';
import {
  createCalendarParser,
  detectParser,
  expandIcsEventDates,
  icsParser,
  jsonParser,
  parseIcsDate,
  parseIcsEvents,
  parseJsonEvents,
  parseRRule,
  unfoldLines,
} from '../index';
import type { CalendarParser, ParsedCalendarEvent } from '../types';

// ---------------------------------------------------------------------------
// ICS test fixtures
// ---------------------------------------------------------------------------

const singleDayIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Vacation
DTSTART;VALUE=DATE:20260407
DTEND;VALUE=DATE:20260408
END:VEVENT
END:VCALENDAR`;

const multiDayIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Sick leave
DTSTART;VALUE=DATE:20260411
DTEND;VALUE=DATE:20260414
END:VEVENT
END:VCALENDAR`;

const weeklyRecurringIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Bruno C - Vacation
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260604
RRULE:FREQ=WEEKLY;COUNT=2
END:VEVENT
END:VCALENDAR`;

const weeklyByDayIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Bruno C - Off
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260602
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260612
END:VEVENT
END:VCALENDAR`;

const dailyUntilIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Bruno C - Off
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260602
RRULE:FREQ=DAILY;UNTIL=20260603T235959Z
END:VEVENT
END:VCALENDAR`;

const cancelledIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Cancelled event
DTSTART;VALUE=DATE:20260407
DTEND;VALUE=DATE:20260408
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
SUMMARY:Active event
DTSTART;VALUE=DATE:20260408
DTEND;VALUE=DATE:20260409
END:VEVENT
END:VCALENDAR`;

const foldedIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:A very long summary that
  continues on the next line
DTSTART;VALUE=DATE:20260407
DTEND;VALUE=DATE:20260408
END:VEVENT
END:VCALENDAR`;

const exdateIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Bruno C - Off
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260602
RRULE:FREQ=DAILY;COUNT=5
EXDATE;VALUE=DATE:20260603
END:VEVENT
END:VCALENDAR`;

// ---------------------------------------------------------------------------
// unfoldLines
// ---------------------------------------------------------------------------

describe('unfoldLines', () => {
  it('unfolds continuation lines starting with a space', () => {
    const raw = 'SUMMARY:A very long summary that\n  continues on the next line';
    expect(unfoldLines(raw)).toEqual([
      'SUMMARY:A very long summary that continues on the next line',
    ]);
  });

  it('unfolds continuation lines starting with a tab', () => {
    const raw = 'SUMMARY:A very long summary that\n\tcontinues on the next line';
    expect(unfoldLines(raw)).toEqual([
      'SUMMARY:A very long summary thatcontinues on the next line',
    ]);
  });

  it('leaves non-continuation lines unchanged', () => {
    const raw = 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR';
    expect(unfoldLines(raw)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR']);
  });

  it('handles empty input', () => {
    expect(unfoldLines('')).toEqual(['']);
  });
});

// ---------------------------------------------------------------------------
// parseIcsDate
// ---------------------------------------------------------------------------

describe('parseIcsDate', () => {
  it('parses a bare YYYYMMDD date', () => {
    expect(parseIcsDate('20260407')).toBe('2026-04-07');
  });

  it('parses a VALUE=DATE prefixed value', () => {
    expect(parseIcsDate(';VALUE=DATE:20260407')).toBe('2026-04-07');
  });

  it('parses a UTC DATE-TIME', () => {
    expect(parseIcsDate('20260603T235959Z')).toBe('2026-06-03');
  });

  it('returns null for values with fewer than 8 digits', () => {
    expect(parseIcsDate('2026')).toBeNull();
    expect(parseIcsDate('abc')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseRRule
// ---------------------------------------------------------------------------

describe('parseRRule', () => {
  it('parses FREQ=WEEKLY;COUNT=2', () => {
    expect(parseRRule('FREQ=WEEKLY;COUNT=2')).toEqual({
      FREQ: 'WEEKLY',
      COUNT: '2',
    });
  });

  it('parses FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260612', () => {
    expect(parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260612')).toEqual({
      FREQ: 'WEEKLY',
      BYDAY: 'MO,WE,FR',
      UNTIL: '20260612',
    });
  });

  it('handles empty string', () => {
    expect(parseRRule('')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseIcsEvents
// ---------------------------------------------------------------------------

describe('parseIcsEvents', () => {
  it('parses a single all-day event', () => {
    const events = parseIcsEvents(singleDayIcs);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Vacation');
    expect(events[0].dtstart).toContain('20260407');
  });

  it('parses multi-day events', () => {
    const events = parseIcsEvents(multiDayIcs);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Sick leave');
    expect(events[0].dtend).toContain('20260414');
  });

  it('skips CANCELLED events', () => {
    const events = parseIcsEvents(cancelledIcs);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Active event');
  });

  it('extracts RRULE', () => {
    const events = parseIcsEvents(weeklyRecurringIcs);
    expect(events).toHaveLength(1);
    expect(events[0].rrule).toBe('FREQ=WEEKLY;COUNT=2');
  });

  it('extracts EXDATE', () => {
    const events = parseIcsEvents(exdateIcs);
    expect(events).toHaveLength(1);
    expect(events[0].exdates.length).toBeGreaterThanOrEqual(1);
  });

  it('handles folded ICS', () => {
    const events = parseIcsEvents(foldedIcs);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe(
      'A very long summary that continues on the next line',
    );
  });

  it('returns empty array for empty input', () => {
    expect(parseIcsEvents('')).toEqual([]);
  });

  it('returns empty array for ICS with no VEVENT', () => {
    expect(parseIcsEvents('BEGIN:VCALENDAR\nEND:VCALENDAR')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// expandIcsEventDates
// ---------------------------------------------------------------------------

describe('expandIcsEventDates', () => {
  const makeEvent = (overrides: Partial<ParsedCalendarEvent> = {}): ParsedCalendarEvent => ({
    summary: 'Test',
    dtstart: ';VALUE=DATE:20260407',
    dtend: ';VALUE=DATE:20260408',
    rrule: '',
    exdates: [],
    ...overrides,
  });

  it('expands a single-day event to one date', () => {
    const event = makeEvent();
    const result = expandIcsEventDates(event, '2026-04-01', '2026-04-30');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: '2026-04-07', summary: 'Test' });
  });

  it('expands a multi-day event (inclusive DTEND is exclusive)', () => {
    const event = makeEvent({
      dtstart: ';VALUE=DATE:20260411',
      dtend: ';VALUE=DATE:20260414',
    });
    const result = expandIcsEventDates(event, '2026-04-01', '2026-04-30');
    expect(result).toEqual([
      { date: '2026-04-11', summary: 'Test' },
      { date: '2026-04-12', summary: 'Test' },
      { date: '2026-04-13', summary: 'Test' },
    ]);
  });

  it('filters dates outside the requested range', () => {
    const event = makeEvent({
      dtstart: ';VALUE=DATE:20260407',
      dtend: ';VALUE=DATE:20260410',
    });
    const result = expandIcsEventDates(event, '2026-04-08', '2026-04-08');
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-04-08');
  });

  it('expands WEEKLY recurring events (ADA-462a multi-day span)', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Bruno C - Vacation',
      dtstart: ';VALUE=DATE:20260601',
      dtend: ';VALUE=DATE:20260604',
      rrule: 'FREQ=WEEKLY;COUNT=2',
      exdates: [],
    };
    const result = expandIcsEventDates(event, '2026-06-01', '2026-06-30');
    // Week 1: Mon–Wed (Jun 1–3), Week 2: Mon–Wed (Jun 8–10)
    expect(result.map((r) => r.date)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-03',
      '2026-06-08', '2026-06-09', '2026-06-10',
    ]);
  });

  it('honors BYDAY in WEEKLY expansion (ADA-462b)', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Bruno C - Off',
      dtstart: ';VALUE=DATE:20260601',
      dtend: ';VALUE=DATE:20260602',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260612',
      exdates: [],
    };
    const result = expandIcsEventDates(event, '2026-06-01', '2026-06-30');
    expect(result.map((r) => r.date)).toEqual([
      '2026-06-01', '2026-06-03', '2026-06-05',
      '2026-06-08', '2026-06-10', '2026-06-12',
    ]);
  });

  it('respects UNTIL inclusively (ADA-462c UTC DATE-TIME)', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Bruno C - Off',
      dtstart: ';VALUE=DATE:20260601',
      dtend: ';VALUE=DATE:20260602',
      rrule: 'FREQ=DAILY;UNTIL=20260603T235959Z',
      exdates: [],
    };
    const result = expandIcsEventDates(event, '2026-06-01', '2026-06-30');
    expect(result.map((r) => r.date)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-03',
    ]);
  });

  it('excludes EXDATE dates', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Bruno C - Off',
      dtstart: ';VALUE=DATE:20260601',
      dtend: ';VALUE=DATE:20260602',
      rrule: 'FREQ=DAILY;COUNT=5',
      exdates: [';VALUE=DATE:20260603'],
    };
    const result = expandIcsEventDates(event, '2026-06-01', '2026-06-30');
    expect(result.map((r) => r.date)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-04', '2026-06-05',
    ]);
  });

  it('returns empty for event without a valid start date', () => {
    const event = makeEvent({ dtstart: '' });
    expect(expandIcsEventDates(event, '2026-04-01', '2026-04-30')).toEqual([]);
  });

  it('keeps weekend dates in expansion', () => {
    // Event spans Sat 2026-04-11 through Mon 2026-04-13
    const event = makeEvent({
      dtstart: ';VALUE=DATE:20260411',
      dtend: ';VALUE=DATE:20260414',
    });
    const result = expandIcsEventDates(event, '2026-04-11', '2026-04-13');
    expect(result.map((r) => r.date)).toEqual([
      '2026-04-11', '2026-04-12', '2026-04-13',
    ]);
  });

  it('expands DAILY recurring events', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Daily standup',
      dtstart: ';VALUE=DATE:20260601',
      dtend: ';VALUE=DATE:20260602',
      rrule: 'FREQ=DAILY;COUNT=3',
      exdates: [],
    };
    const result = expandIcsEventDates(event, '2026-06-01', '2026-06-30');
    expect(result.map((r) => r.date)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-03',
    ]);
  });

  it('expands MONTHLY recurring events', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Monthly review',
      dtstart: ';VALUE=DATE:20260115',
      dtend: ';VALUE=DATE:20260116',
      rrule: 'FREQ=MONTHLY;COUNT=3',
      exdates: [],
    };
    const result = expandIcsEventDates(event, '2026-01-01', '2026-12-31');
    expect(result.map((r) => r.date)).toEqual([
      '2026-01-15', '2026-02-15', '2026-03-15',
    ]);
  });

  it('expands YEARLY recurring events', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Annual checkup',
      dtstart: ';VALUE=DATE:20260101',
      dtend: ';VALUE=DATE:20260102',
      rrule: 'FREQ=YEARLY;COUNT=2',
      exdates: [],
    };
    const result = expandIcsEventDates(event, '2026-01-01', '2028-12-31');
    expect(result.map((r) => r.date)).toEqual([
      '2026-01-01', '2027-01-01',
    ]);
  });

  it('caps recurrence at hard limit (rangeStart + 1 year)', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Weekly forever',
      dtstart: ';VALUE=DATE:20260101',
      dtend: ';VALUE=DATE:20260102',
      rrule: 'FREQ=WEEKLY', // no COUNT/UNTIL → should hit hard limit
      exdates: [],
    };
    const result = expandIcsEventDates(event, '2026-01-01', '2026-06-30');
    // Should stop at hardLimit (1 year from rangeStart) which is 2027-01-01
    // So we expect ~52 weekly occurrences, but only those within rangeStart..rangeEnd
    // Range is 2026-01-01 to 2026-06-30, that's about 26 weeks
    expect(result.length).toBeGreaterThan(20);
    expect(result.length).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
// icsParser
// ---------------------------------------------------------------------------

describe('icsParser', () => {
  it('parses ICS text via the icsParser object', () => {
    const events = icsParser.parse(singleDayIcs);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Vacation');
  });

  it('expands events via the icsParser object', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Test',
      dtstart: ';VALUE=DATE:20260407',
      dtend: ';VALUE=DATE:20260408',
      rrule: '',
      exdates: [],
    };
    const result = icsParser.expand(event, '2026-04-01', '2026-04-30');
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-04-07');
  });
});

// ---------------------------------------------------------------------------
// createCalendarParser
// ---------------------------------------------------------------------------

describe('createCalendarParser', () => {
  it('returns a CalendarParser for absence feeds', () => {
    const parser = createCalendarParser('absence');
    const events = parser.parse(singleDayIcs);
    expect(events).toHaveLength(1);
  });

  it('returns a CalendarParser for holiday feeds', () => {
    const parser = createCalendarParser('holiday');
    const events = parser.parse(singleDayIcs);
    expect(events).toHaveLength(1);
  });

  it('returns the same icsParser instance for both feed types', () => {
    const absenceParser = createCalendarParser('absence');
    const holidayParser = createCalendarParser('holiday');
    expect(absenceParser).toBe(holidayParser);
    expect(absenceParser).toBe(icsParser);
  });
});

// ---------------------------------------------------------------------------
// barrel export smoke
// ---------------------------------------------------------------------------

describe('barrel exports', () => {
  it('re-exports createCalendarParser', () => {
    expect(typeof createCalendarParser).toBe('function');
  });

  it('re-exports parseIcsEvents', () => {
    const events = parseIcsEvents(singleDayIcs);
    expect(events).toHaveLength(1);
  });

  it('re-exports expandIcsEventDates', () => {
    const event: ParsedCalendarEvent = {
      summary: 'T',
      dtstart: '20260407',
      dtend: '20260408',
      rrule: '',
      exdates: [],
    };
    expect(expandIcsEventDates(event, '2026-04-01', '2026-04-30')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// jsonParser
// ---------------------------------------------------------------------------

const singleDayJson = JSON.stringify([
  { summary: 'Vacation', dtstart: '2026-04-07', dtend: '2026-04-08' },
]);

const multiDayJson = JSON.stringify([
  { summary: 'Sick leave', dtstart: '2026-04-11', dtend: '2026-04-14' },
]);

const recurringJson = JSON.stringify([
  {
    summary: 'Bruno C - Vacation',
    dtstart: '2026-06-01',
    dtend: '2026-06-04',
    rrule: 'FREQ=WEEKLY;COUNT=2',
  },
]);

const exdateJson = JSON.stringify([
  {
    summary: 'Bruno C - Off',
    dtstart: '2026-06-01',
    dtend: '2026-06-02',
    rrule: 'FREQ=DAILY;COUNT=5',
    exdates: ['2026-06-03'],
  },
]);

const multipleEventsJson = JSON.stringify([
  { summary: 'Event 1', dtstart: '2026-04-07', dtend: '2026-04-08' },
  { summary: 'Event 2', dtstart: '2026-04-09', dtend: '2026-04-10' },
]);

describe('parseJsonEvents', () => {
  it('parses a single event from a JSON array', () => {
    const events = parseJsonEvents(singleDayJson);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Vacation');
    expect(events[0].dtstart).toBe('2026-04-07');
    expect(events[0].dtend).toBe('2026-04-08');
    expect(events[0].rrule).toBe('');
    expect(events[0].exdates).toEqual([]);
  });

  it('parses multi-day events', () => {
    const events = parseJsonEvents(multiDayJson);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Sick leave');
    expect(events[0].dtstart).toBe('2026-04-11');
    expect(events[0].dtend).toBe('2026-04-14');
  });

  it('parses events with an rrule', () => {
    const events = parseJsonEvents(recurringJson);
    expect(events).toHaveLength(1);
    expect(events[0].rrule).toBe('FREQ=WEEKLY;COUNT=2');
  });

  it('parses events with exdates', () => {
    const events = parseJsonEvents(exdateJson);
    expect(events).toHaveLength(1);
    expect(events[0].exdates).toEqual(['2026-06-03']);
  });

  it('parses multiple events from a JSON array', () => {
    const events = parseJsonEvents(multipleEventsJson);
    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe('Event 1');
    expect(events[1].summary).toBe('Event 2');
  });

  it('returns [] for invalid JSON', () => {
    expect(parseJsonEvents('not json')).toEqual([]);
    expect(parseJsonEvents('{broken}')).toEqual([]);
    expect(parseJsonEvents('')).toEqual([]);
  });

  it('returns [] for non-array, non-object JSON values', () => {
    expect(parseJsonEvents('null')).toEqual([]);
    expect(parseJsonEvents('"string"')).toEqual([]);
    expect(parseJsonEvents('42')).toEqual([]);
  });

  it('skips items missing required fields', () => {
    const json = JSON.stringify([
      { summary: 'Valid', dtstart: '2026-04-07', dtend: '2026-04-08' },
      { summary: '', dtstart: '2026-04-09', dtend: '2026-04-10' },
      { dtstart: '2026-04-11', dtend: '2026-04-12' },
      { summary: 'No dates', dtstart: '', dtend: '' },
    ]);
    const events = parseJsonEvents(json);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Valid');
  });

  it('trims whitespace from summary and dates', () => {
    const json = JSON.stringify([
      {
        summary: '  Vacation  ',
        dtstart: '  2026-04-07  ',
        dtend: '  2026-04-08  ',
      },
    ]);
    const events = parseJsonEvents(json);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Vacation');
    expect(events[0].dtstart).toBe('2026-04-07');
    expect(events[0].dtend).toBe('2026-04-08');
  });

  it('tolerates a single JSON object (wraps it in an array)', () => {
    const json = JSON.stringify({
      summary: 'Vacation',
      dtstart: '2026-04-07',
      dtend: '2026-04-08',
    });
    const events = parseJsonEvents(json);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Vacation');
  });

  it('filters out exdates that are empty strings', () => {
    const json = JSON.stringify([
      {
        summary: 'Event',
        dtstart: '2026-04-07',
        dtend: '2026-04-08',
        exdates: ['2026-04-09', '', '2026-04-10'],
      },
    ]);
    const events = parseJsonEvents(json);
    expect(events[0].exdates).toEqual(['2026-04-09', '2026-04-10']);
  });
});

describe('jsonParser', () => {
  it('parses JSON text via the jsonParser object', () => {
    const events = jsonParser.parse(singleDayJson);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Vacation');
  });

  it('expands events via the jsonParser object', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Test',
      dtstart: '2026-04-07',
      dtend: '2026-04-08',
      rrule: '',
      exdates: [],
    };
    const result = jsonParser.expand(event, '2026-04-01', '2026-04-30');
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-04-07');
  });

  it('expands recurring events', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Weekly',
      dtstart: '2026-06-01',
      dtend: '2026-06-02',
      rrule: 'FREQ=WEEKLY;COUNT=3',
      exdates: [],
    };
    const result = jsonParser.expand(event, '2026-06-01', '2026-06-30');
    expect(result).toHaveLength(3);
    expect(result[0].date).toBe('2026-06-01');
    expect(result[1].date).toBe('2026-06-08');
    expect(result[2].date).toBe('2026-06-15');
  });

  it('expands events with exclusions', () => {
    const event: ParsedCalendarEvent = {
      summary: 'Off',
      dtstart: '2026-06-01',
      dtend: '2026-06-02',
      rrule: 'FREQ=DAILY;COUNT=5',
      exdates: ['2026-06-03'],
    };
    const result = jsonParser.expand(event, '2026-06-01', '2026-06-10');
    expect(result.map((r) => r.date)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-04', '2026-06-05',
    ]);
  });
});

// ---------------------------------------------------------------------------
// detectParser
// ---------------------------------------------------------------------------

describe('detectParser', () => {
  it('returns jsonParser for JSON array payloads', () => {
    const parser = detectParser(singleDayJson);
    expect(parser).toBe(jsonParser);
  });

  it('returns jsonParser for JSON object payloads', () => {
    const parser = detectParser('{"summary":"test","dtstart":"2026-04-07","dtend":"2026-04-08"}');
    expect(parser).toBe(jsonParser);
  });

  it('returns icsParser for ICS payloads', () => {
    const parser = detectParser('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR');
    expect(parser).toBe(icsParser);
  });

  it('returns icsParser for ambiguous text', () => {
    const parser = detectParser('some random text');
    expect(parser).toBe(icsParser);
  });

  it('returns icsParser for empty string', () => {
    const parser = detectParser('');
    expect(parser).toBe(icsParser);
  });
});

// ---------------------------------------------------------------------------
// jsonParser + detectParser integration: round-trip
// ---------------------------------------------------------------------------

describe('jsonParser integration', () => {
  it('parses and expands through detectParser', () => {
    const parser = detectParser(singleDayJson);
    const events = parser.parse(singleDayJson);
    expect(events).toHaveLength(1);
    const dates = parser.expand(events[0], '2026-04-01', '2026-04-30');
    expect(dates).toHaveLength(1);
    expect(dates[0].date).toBe('2026-04-07');
  });

  it('handles multi-event JSON feeds', () => {
    const parser = detectParser(multipleEventsJson);
    const events = parser.parse(multipleEventsJson);
    expect(events).toHaveLength(2);
  });
});
