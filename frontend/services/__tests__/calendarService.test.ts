import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCalendarSuggestions } from '../calendarService';

function mockIcs(ics: string) {
	vi.spyOn(global, 'fetch').mockResolvedValue({
		ok: true,
		text: async () => ics,
	} as Response);
}

const feed = {
	label: 'Work',
	url: 'https://calendar.example.com/work.ics',
	type: 'suggestion' as const,
};

/**
 * Local-day equivalent of a UTC instant, mirroring the production
 * `toLocalDateString` so the expected value tracks whatever TZ the suite runs
 * under (TZ=America/Sao_Paulo vs a UTC+ zone).
 */
function localDay(utcIso: string): string {
	const d = new Date(utcIso);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

describe('calendarService', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('attributes a UTC-stamped event to the user local calendar day (ADA-463)', async () => {
		// 23:00Z on Wed 2026-06-10. For a UTC+ user this rolls into Thu 06-11;
		// for UTC-3 (São Paulo) it stays Wed 06-10 (20:00 local). Either way the
		// day must be the *local* day, never the raw UTC digits unconditionally.
		mockIcs(`BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:ADA-100 Sync
DTSTART:20260610T230000Z
DTEND:20260611T000000Z
END:VEVENT
END:VCALENDAR`);

		const suggestions = await fetchCalendarSuggestions(
			[feed],
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		const expectedDay = localDay('2026-06-10T23:00:00Z');
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].date).toBe(expectedDay);
		expect(suggestions[0].issueKey).toBe('ADA-100');
	});

	it('keeps a floating (no-Z) local datetime on its wall-clock day', async () => {
		// No Z / offset → floating time, interpreted in local TZ. 09:00 local on
		// 2026-06-10 stays 2026-06-10 regardless of TZ.
		mockIcs(`BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:ADA-200 Standup
DTSTART:20260610T090000
DTEND:20260610T093000
END:VEVENT
END:VCALENDAR`);

		const suggestions = await fetchCalendarSuggestions(
			[feed],
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].date).toBe('2026-06-10');
		expect(suggestions[0].issueKey).toBe('ADA-200');
	});

	it('expands a WEEKLY;BYDAY=MO,WE,FR recurrence to local days', async () => {
		// Floating 10:00 local meeting recurring Mon/Wed/Fri.
		mockIcs(`BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:ADA-300 Pairing
DTSTART:20260601T100000
DTEND:20260601T110000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260612T235959Z
END:VEVENT
END:VCALENDAR`);

		const suggestions = await fetchCalendarSuggestions(
			[feed],
			'',
			'2026-06-01',
			'2026-06-12',
			[],
		);

		const days = suggestions
			.map((s) => s.date)
			.sort((a, b) => a.localeCompare(b));
		// Mon 06-01, Wed 06-03, Fri 06-05, Mon 06-08, Wed 06-10, Fri 06-12.
		expect(days).toEqual([
			'2026-06-01',
			'2026-06-03',
			'2026-06-05',
			'2026-06-08',
			'2026-06-10',
			'2026-06-12',
		]);
		expect(suggestions.every((s) => s.issueKey === 'ADA-300')).toBe(true);
	});

	it('expands a DAILY recurrence honoring UNTIL', async () => {
		mockIcs(`BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:ADA-400 Daily
DTSTART:20260608T090000
DTEND:20260608T093000
RRULE:FREQ=DAILY;UNTIL=20260610T235959Z
END:VEVENT
END:VCALENDAR`);

		const suggestions = await fetchCalendarSuggestions(
			[feed],
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		const days = suggestions
			.map((s) => s.date)
			.sort((a, b) => a.localeCompare(b));
		expect(days).toEqual(['2026-06-08', '2026-06-09', '2026-06-10']);
	});
});
