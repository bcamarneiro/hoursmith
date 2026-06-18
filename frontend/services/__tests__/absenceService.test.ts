import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAbsenceDays, fetchAbsenceDaysByUser } from '../absenceService';

const teamCalendarIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Bruno C - Vacation
DTSTART;VALUE=DATE:20260407
DTEND;VALUE=DATE:20260408
END:VEVENT
BEGIN:VEVENT
SUMMARY:Daniel D - Sick
DTSTART;VALUE=DATE:20260408
DTEND;VALUE=DATE:20260409
END:VEVENT
BEGIN:VEVENT
SUMMARY:Bruno C - Off
DTSTART;VALUE=DATE:20260409
DTEND;VALUE=DATE:20260410
END:VEVENT
END:VCALENDAR`;

describe('absenceService', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('assigns shared absence events to the configured users by title pattern', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			text: async () => teamCalendarIcs,
		} as Response);

		const result = await fetchAbsenceDaysByUser(
			[
				{
					label: 'Team vacations',
					url: 'https://calendar.example.com/team.ics',
					type: 'absence',
					absenceAttribution: 'shared',
				},
			],
			[
				{ pattern: 'Bruno C', userEmails: ['bruno@example.com'] },
				{ pattern: 'Daniel D', userEmails: ['daniel@example.com'] },
			],
			'bruno@example.com',
			'',
			'2026-04-06',
			'2026-04-10',
		);

		expect([...(result.get('bruno@example.com')?.keys() ?? [])]).toEqual([
			'2026-04-07',
			'2026-04-09',
		]);
		expect([...(result.get('daniel@example.com')?.keys() ?? [])]).toEqual([
			'2026-04-08',
		]);
		expect(result.get('bruno@example.com')?.get('2026-04-07')?.kind).toBe(
			'vacation',
		);
		expect(result.get('bruno@example.com')?.get('2026-04-09')?.kind).toBe(
			'off',
		);
		expect(result.get('daniel@example.com')?.get('2026-04-08')?.kind).toBe(
			'sick',
		);
		expect(result.has('nobody@example.com')).toBe(false);
	});

	it('falls back to the personal title filter for the current user', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			text: async () => teamCalendarIcs,
		} as Response);

		const result = await fetchAbsenceDays(
			[
				{
					label: 'Team vacations',
					url: 'https://calendar.example.com/team.ics',
					type: 'absence',
					absenceAttribution: 'self',
					titleFilter: 'Bruno C',
				},
			],
			[],
			'bruno@example.com',
			'',
			'2026-04-06',
			'2026-04-10',
		);

		expect([...result.keys()]).toEqual(['2026-04-07', '2026-04-09']);
		expect(result.get('2026-04-07')?.reasons).toEqual([
			'[Team vacations] Bruno C - Vacation',
		]);
		expect(result.get('2026-04-07')?.kind).toBe('vacation');
		expect(result.get('2026-04-09')?.kind).toBe('off');
	});

	it('keeps weekend dates in the expanded absence range (no silent skipping)', async () => {
		// Event spans Saturday 2026-04-11 through Monday 2026-04-13 (DTEND is
		// exclusive, so 04-14). All three dates should appear in the user's
		// absence map even though Sat/Sun have zero compliance target.
		vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			text: async () => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Bruno C - Sick
DTSTART;VALUE=DATE:20260411
DTEND;VALUE=DATE:20260414
END:VEVENT
END:VCALENDAR`,
		} as Response);

		const result = await fetchAbsenceDays(
			[
				{
					label: 'Team time off',
					url: 'https://calendar.example.com/team.ics',
					type: 'absence',
					absenceAttribution: 'self',
					titleFilter: 'Bruno C',
				},
			],
			[],
			'bruno@example.com',
			'',
			'2026-04-11',
			'2026-04-13',
		);

		expect([...result.keys()]).toEqual([
			'2026-04-11',
			'2026-04-12',
			'2026-04-13',
		]);
	});

	it('applies a holiday feed to every user known from absence feeds', async () => {
		// Two feeds: one absence feed that introduces Alice and Bob, plus a
		// holiday feed for May 1. Both users should end up with the holiday.
		vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('absence')) {
				return {
					ok: true,
					text: async () => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Alice - Vacation
DTSTART;VALUE=DATE:20260504
DTEND;VALUE=DATE:20260505
END:VEVENT
BEGIN:VEVENT
SUMMARY:Bob - Vacation
DTSTART;VALUE=DATE:20260505
DTEND;VALUE=DATE:20260506
END:VEVENT
END:VCALENDAR`,
				} as Response;
			}
			return {
				ok: true,
				text: async () => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Labour Day
DTSTART;VALUE=DATE:20260501
DTEND;VALUE=DATE:20260502
END:VEVENT
END:VCALENDAR`,
			} as Response;
		});

		const result = await fetchAbsenceDaysByUser(
			[
				{
					label: 'Team time off',
					url: 'https://calendar.example.com/absence.ics',
					type: 'absence',
					absenceAttribution: 'shared',
				},
				{
					label: 'PT holidays',
					url: 'https://calendar.example.com/holidays.ics',
					type: 'holiday',
				},
			],
			[
				{ pattern: 'Alice', userEmails: ['alice@example.com'] },
				{ pattern: 'Bob', userEmails: ['bob@example.com'] },
			],
			'alice@example.com',
			'',
			'2026-05-01',
			'2026-05-08',
		);

		expect(result.get('alice@example.com')?.get('2026-05-01')?.kind).toBe(
			'holiday',
		);
		expect(result.get('bob@example.com')?.get('2026-05-01')?.kind).toBe(
			'holiday',
		);
		// Personal absences still surface alongside the holiday.
		expect(result.get('alice@example.com')?.get('2026-05-04')?.kind).toBe(
			'vacation',
		);
		expect(result.get('bob@example.com')?.get('2026-05-05')?.kind).toBe(
			'vacation',
		);
	});

	it('scopes regional holidays to assigned users; leaves nationwide ones applying to everyone', async () => {
		// One holiday feed mixing a nationwide event (Labour Day) and a
		// regional one (Lisbon Day). Three users known via shared absence feed.
		vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('absence')) {
				return {
					ok: true,
					text: async () => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Alice - Vacation
DTSTART;VALUE=DATE:20260520
DTEND;VALUE=DATE:20260521
END:VEVENT
BEGIN:VEVENT
SUMMARY:Bob - Vacation
DTSTART;VALUE=DATE:20260521
DTEND;VALUE=DATE:20260522
END:VEVENT
BEGIN:VEVENT
SUMMARY:Carla - Vacation
DTSTART;VALUE=DATE:20260522
DTEND;VALUE=DATE:20260523
END:VEVENT
END:VCALENDAR`,
				} as Response;
			}
			return {
				ok: true,
				text: async () => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Labour Day
DTSTART;VALUE=DATE:20260501
DTEND;VALUE=DATE:20260502
END:VEVENT
BEGIN:VEVENT
SUMMARY:Lisbon Day
DTSTART;VALUE=DATE:20260613
DTEND;VALUE=DATE:20260614
END:VEVENT
END:VCALENDAR`,
			} as Response;
		});

		const result = await fetchAbsenceDaysByUser(
			[
				{
					label: 'Team time off',
					url: 'https://calendar.example.com/absence.ics',
					type: 'absence',
					absenceAttribution: 'shared',
				},
				{
					label: 'PT holidays',
					url: 'https://calendar.example.com/holidays.ics',
					type: 'holiday',
				},
			],
			[
				{ pattern: 'Alice', userEmails: ['alice@example.com'] },
				{ pattern: 'Bob', userEmails: ['bob@example.com'] },
				{ pattern: 'Carla', userEmails: ['carla@example.com'] },
				// Regional holiday assignment — Lisbon Day applies only to
				// Alice + Bob, not Carla.
				{
					pattern: 'Lisbon Day',
					userEmails: ['alice@example.com', 'bob@example.com'],
				},
			],
			'alice@example.com',
			'',
			'2026-05-01',
			'2026-06-30',
		);

		// Nationwide Labour Day → everyone
		expect(result.get('alice@example.com')?.get('2026-05-01')?.kind).toBe(
			'holiday',
		);
		expect(result.get('bob@example.com')?.get('2026-05-01')?.kind).toBe(
			'holiday',
		);
		expect(result.get('carla@example.com')?.get('2026-05-01')?.kind).toBe(
			'holiday',
		);

		// Regional Lisbon Day → only Alice + Bob
		expect(result.get('alice@example.com')?.get('2026-06-13')?.kind).toBe(
			'holiday',
		);
		expect(result.get('bob@example.com')?.get('2026-06-13')?.kind).toBe(
			'holiday',
		);
		expect(result.get('carla@example.com')?.has('2026-06-13')).toBe(false);
	});

	it('returns the current user with holidays even when no absence feed exists', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			text: async () => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Labour Day
DTSTART;VALUE=DATE:20260501
DTEND;VALUE=DATE:20260502
END:VEVENT
END:VCALENDAR`,
		} as Response);

		const result = await fetchAbsenceDays(
			[
				{
					label: 'PT holidays',
					url: 'https://calendar.example.com/holidays.ics',
					type: 'holiday',
				},
			],
			[],
			'solo@example.com',
			'',
			'2026-05-01',
			'2026-05-08',
		);

		expect([...result.keys()]).toEqual(['2026-05-01']);
		expect(result.get('2026-05-01')?.kind).toBe('holiday');
	});

	it('spans the full DTEND−DTSTART duration for each recurring occurrence (ADA-462a)', async () => {
		// A 3-day vacation (Mon–Wed; DTEND exclusive = Thu) that recurs WEEKLY.
		// Each weekly occurrence must emit all three days, not just the start.
		vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			text: async () => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Bruno C - Vacation
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260604
RRULE:FREQ=WEEKLY;COUNT=2
END:VEVENT
END:VCALENDAR`,
		} as Response);

		const result = await fetchAbsenceDays(
			[
				{
					label: 'Team time off',
					url: 'https://calendar.example.com/team.ics',
					type: 'absence',
					absenceAttribution: 'self',
					titleFilter: 'Bruno C',
				},
			],
			[],
			'bruno@example.com',
			'',
			'2026-06-01',
			'2026-06-30',
		);

		expect([...result.keys()]).toEqual([
			// Week 1: Mon–Wed
			'2026-06-01',
			'2026-06-02',
			'2026-06-03',
			// Week 2: Mon–Wed
			'2026-06-08',
			'2026-06-09',
			'2026-06-10',
		]);
	});

	it('honors WEEKLY;BYDAY=MO,WE,FR with INTERVAL (ADA-462b)', async () => {
		// FREQ=WEEKLY;BYDAY=MO,WE,FR starting Mon 2026-06-01 should emit
		// Mon/Wed/Fri each week. DTSTART = DTEND-1 → single-day occurrences.
		vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			text: async () => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Bruno C - Off
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260602
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260612
END:VEVENT
END:VCALENDAR`,
		} as Response);

		const result = await fetchAbsenceDays(
			[
				{
					label: 'Team time off',
					url: 'https://calendar.example.com/team.ics',
					type: 'absence',
					absenceAttribution: 'self',
					titleFilter: 'Bruno C',
				},
			],
			[],
			'bruno@example.com',
			'',
			'2026-06-01',
			'2026-06-30',
		);

		// Mon 06-01, Wed 06-03, Fri 06-05, Mon 06-08, Wed 06-10, Fri 06-12.
		// UNTIL=20260612 is inclusive of Fri 06-12.
		expect([...result.keys()]).toEqual([
			'2026-06-01',
			'2026-06-03',
			'2026-06-05',
			'2026-06-08',
			'2026-06-10',
			'2026-06-12',
		]);
	});

	it('respects UNTIL consistently for recurring all-day events (ADA-462c)', async () => {
		// UNTIL given as a UTC DATE-TIME. The final occurrence on the UNTIL day
		// must stay included regardless of viewer TZ.
		vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			text: async () => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Bruno C - Off
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260602
RRULE:FREQ=DAILY;UNTIL=20260603T235959Z
END:VEVENT
END:VCALENDAR`,
		} as Response);

		const result = await fetchAbsenceDays(
			[
				{
					label: 'Team time off',
					url: 'https://calendar.example.com/team.ics',
					type: 'absence',
					absenceAttribution: 'self',
					titleFilter: 'Bruno C',
				},
			],
			[],
			'bruno@example.com',
			'',
			'2026-06-01',
			'2026-06-30',
		);

		expect([...result.keys()]).toEqual([
			'2026-06-01',
			'2026-06-02',
			'2026-06-03',
		]);
	});

	it('prefers sick over other absence kinds when a day has multiple events', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			text: async () => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Bruno C - Off
DTSTART;VALUE=DATE:20260407
DTEND;VALUE=DATE:20260408
END:VEVENT
BEGIN:VEVENT
SUMMARY:Bruno C - Sick
DTSTART;VALUE=DATE:20260407
DTEND;VALUE=DATE:20260408
END:VEVENT
END:VCALENDAR`,
		} as Response);

		const result = await fetchAbsenceDaysByUser(
			[
				{
					label: 'Team time off',
					url: 'https://calendar.example.com/team.ics',
					type: 'absence',
					absenceAttribution: 'shared',
				},
			],
			[{ pattern: 'Bruno C', userEmails: ['bruno@example.com'] }],
			'bruno@example.com',
			'',
			'2026-04-06',
			'2026-04-10',
		);

		expect(result.get('bruno@example.com')?.get('2026-04-07')?.kind).toBe(
			'sick',
		);
	});
});
