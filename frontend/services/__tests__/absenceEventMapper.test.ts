import { describe, expect, it, vi } from 'vitest';
import {
	mapDatesAndPublish,
	mapDatesToAbsenceRecords,
	mapHolidayDatesAndPublish,
	mapHolidayDatesToRecords,
	classifyAbsenceKind,
	normalizeAssignments,
} from '../absenceEventMapper';
import type { NormalisedAssignment } from '../eventMatcher';
import type { AbsencePublishSink } from '../absencePublisher';

describe('classifyAbsenceKind', () => {
	it('returns sick when summary contains "sick"', () => {
		expect(classifyAbsenceKind('Bruno C - Sick')).toBe('sick');
		expect(classifyAbsenceKind('Sick Day')).toBe('sick');
		expect(classifyAbsenceKind('sick - bruno')).toBe('sick');
	});

	it('returns vacation when summary contains "vacation"', () => {
		expect(classifyAbsenceKind('Bruno C - Vacation')).toBe('vacation');
		expect(classifyAbsenceKind('VACATION - Alice')).toBe('vacation');
	});

	it('returns off for any other summary', () => {
		expect(classifyAbsenceKind('Bruno C - Off')).toBe('off');
		expect(classifyAbsenceKind('Day Off')).toBe('off');
		expect(classifyAbsenceKind('Personal day')).toBe('off');
		expect(classifyAbsenceKind('Training')).toBe('off');
	});
});

describe('normalizeAssignments (re-export)', () => {
	it('returns normalised assignments', () => {
		const result = normalizeAssignments([
			{ pattern: '  Bruno C  ', userEmails: ['Bruno@Example.com'] },
		]);
		expect(result).toEqual([
			{ pattern: 'Bruno C', userEmails: ['bruno@example.com'] },
		]);
	});
});

describe('mapDatesToAbsenceRecords', () => {
	const entries = [
		{ date: '2026-04-07', summary: 'Bruno C - Vacation' },
		{ date: '2026-04-08', summary: 'Bruno C - Sick' },
		{ date: '2026-04-09', summary: 'Bruno C - Off' },
	];

	it('creates one record per (user, date) pair', () => {
		const users = new Set(['bruno@example.com']);
		const records = mapDatesToAbsenceRecords(entries, users);

		expect(records).toHaveLength(3);
		expect(records[0]).toEqual({
			user_id: 'bruno@example.com',
			provider_id: null,
			absence_date: '2026-04-07',
			kind: 'vacation',
			reason: 'Bruno C - Vacation',
		});
		expect(records[1]).toEqual({
			user_id: 'bruno@example.com',
			provider_id: null,
			absence_date: '2026-04-08',
			kind: 'sick',
			reason: 'Bruno C - Sick',
		});
		expect(records[2]).toEqual({
			user_id: 'bruno@example.com',
			provider_id: null,
			absence_date: '2026-04-09',
			kind: 'off',
			reason: 'Bruno C - Off',
		});
	});

	it('creates records for multiple users per entry', () => {
		const users = new Set(['alice@example.com', 'bob@example.com']);
		const records = mapDatesToAbsenceRecords(
			[{ date: '2026-04-07', summary: 'Team Standup' }],
			users,
		);

		expect(records).toHaveLength(2);
		expect(records[0].user_id).toBe('alice@example.com');
		expect(records[1].user_id).toBe('bob@example.com');
	});

	it('prepends label to reason when provided', () => {
		const users = new Set(['bruno@example.com']);
		const records = mapDatesToAbsenceRecords(
			[{ date: '2026-04-07', summary: 'Bruno C - Vacation' }],
			users,
			'Team time off',
		);

		expect(records[0].reason).toBe('[Team time off] Bruno C - Vacation');
	});

	it('includes provider_id when provided', () => {
		const users = new Set(['bruno@example.com']);
		const records = mapDatesToAbsenceRecords(
			[{ date: '2026-04-07', summary: 'Vacation' }],
			users,
			undefined,
			'provider-123',
		);

		expect(records[0].provider_id).toBe('provider-123');
	});

	it('returns empty array for empty entries', () => {
		const records = mapDatesToAbsenceRecords([], new Set(['a@b.com']));
		expect(records).toEqual([]);
	});

	it('returns empty array for empty users set', () => {
		const records = mapDatesToAbsenceRecords(
			[{ date: '2026-04-07', summary: 'Vacation' }],
			new Set(),
		);
		expect(records).toEqual([]);
	});
});

describe('mapHolidayDatesToRecords', () => {
	const assignments: NormalisedAssignment[] = [
		{ pattern: 'Lisbon', userEmails: ['alice@example.com', 'bob@example.com'] },
	];

	it('creates regional holiday records for matched users', () => {
		const records = mapHolidayDatesToRecords(
			[{ date: '2026-06-13', summary: 'Lisbon Day' }],
			assignments,
			new Set(),
			'carol@example.com',
		);

		expect(records).toHaveLength(2);
		const alice = records.find((r) => r.user_id === 'alice@example.com');
		const bob = records.find((r) => r.user_id === 'bob@example.com');
		expect(alice).toBeDefined();
		expect(bob).toBeDefined();
		expect(alice!.kind).toBe('holiday');
		expect(alice!.absence_date).toBe('2026-06-13');
	});

	it('creates nationwide holiday records for all known users + current user', () => {
		const records = mapHolidayDatesToRecords(
			[{ date: '2026-05-01', summary: 'Labour Day' }],
			assignments,
			new Set(['alice@example.com', 'bob@example.com']),
			'carol@example.com',
		);

		expect(records).toHaveLength(3);
		const userEmails = records.map((r) => r.user_id);
		expect(userEmails).toEqual(
			expect.arrayContaining([
				'alice@example.com',
				'bob@example.com',
				'carol@example.com',
			]),
		);
		records.forEach((r) => {
			expect(r.kind).toBe('holiday');
			expect(r.absence_date).toBe('2026-05-01');
		});
	});

	it('includes the current user even when knownUsers is empty (no absence feeds)', () => {
		const records = mapHolidayDatesToRecords(
			[{ date: '2026-05-01', summary: 'Labour Day' }],
			[],
			new Set(),
			'solo@example.com',
		);

		expect(records).toHaveLength(1);
		expect(records[0].user_id).toBe('solo@example.com');
		expect(records[0].kind).toBe('holiday');
	});

	it('prepends label to the reason', () => {
		const records = mapHolidayDatesToRecords(
			[{ date: '2026-05-01', summary: 'Labour Day' }],
			[],
			new Set(),
			'solo@example.com',
			'PT Holidays',
		);

		expect(records[0].reason).toBe('[PT Holidays] Labour Day');
	});

	it('includes provider_id when provided', () => {
		const records = mapHolidayDatesToRecords(
			[{ date: '2026-05-01', summary: 'Labour Day' }],
			[],
			new Set(),
			'solo@example.com',
			undefined,
			'provider-456',
		);

		expect(records[0].provider_id).toBe('provider-456');
	});

	it('produces both regional and nationwide records in a single call', () => {
		const records = mapHolidayDatesToRecords(
			[
				{ date: '2026-06-13', summary: 'Lisbon Day' },
				{ date: '2026-05-01', summary: 'Labour Day' },
			],
			assignments,
			new Set(['alice@example.com']),
			'bob@example.com',
		);

		// Lisbon Day → regional (alice + bob from assignment)
		// Labour Day → nationwide (alice + bob)
		// Total: alice gets both, bob gets both
		// Regional: alice, bob (from pattern)
		// Nationwide recipients: alice (known) + bob (current) = alice, bob
		// alice → Lisbon Day (regional) + Labour Day (nationwide) = 2
		// bob → Lisbon Day (regional) + Labour Day (nationwide) = 2
		expect(records).toHaveLength(4);

		const aliceRecords = records.filter(
			(r) => r.user_id === 'alice@example.com',
		);
		const bobRecords = records.filter((r) => r.user_id === 'bob@example.com');

		expect(aliceRecords).toHaveLength(2);
		expect(bobRecords).toHaveLength(2);

		const aliceDates = aliceRecords.map((r) => r.absence_date).sort();
		expect(aliceDates).toEqual(['2026-05-01', '2026-06-13']);

		const bobDates = bobRecords.map((r) => r.absence_date).sort();
		expect(bobDates).toEqual(['2026-05-01', '2026-06-13']);
	});

	it('returns empty array for no entries', () => {
		const records = mapHolidayDatesToRecords(
			[],
			assignments,
			new Set(['alice@example.com']),
			'bob@example.com',
		);
		expect(records).toEqual([]);
	});
});

describe('mapDatesAndPublish', () => {
	it('invokes the publisher upon successful mapping', async () => {
		const sink = vi.fn<AbsencePublishSink>(async () => {});

		const result = await mapDatesAndPublish(
			[{ date: '2026-04-07', summary: 'Bruno C - Vacation' }],
			new Set(['bruno@example.com']),
			undefined,
			'provider-123',
			sink,
		);

		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0][0]).toHaveLength(1);
		expect(sink.mock.calls[0][0][0]).toMatchObject({
			user_id: 'bruno@example.com',
			provider_id: 'provider-123',
			absence_date: '2026-04-07',
			kind: 'vacation',
		});
		expect(result.published).toBe(1);
		expect(result.failed).toBe(0);
	});

	it('is fail-safe when mapping produces nothing: no records, no sink call', async () => {
		const sink = vi.fn<AbsencePublishSink>(async () => {});

		const result = await mapDatesAndPublish(
			[],
			new Set(),
			undefined,
			undefined,
			sink,
		);

		expect(sink).not.toHaveBeenCalled();
		expect(result).toEqual({
			attempted: 0,
			published: 0,
			failed: 0,
			failures: [],
		});
	});
});

describe('mapHolidayDatesAndPublish', () => {
	const assignments: NormalisedAssignment[] = [
		{ pattern: 'Lisbon', userEmails: ['alice@example.com', 'bob@example.com'] },
	];

	it('invokes the publisher upon successful mapping', async () => {
		const sink = vi.fn<AbsencePublishSink>(async () => {});

		const result = await mapHolidayDatesAndPublish(
			[{ date: '2026-05-01', summary: 'Labour Day' }],
			assignments,
			new Set(['alice@example.com']),
			'bob@example.com',
			'PT Holidays',
			'provider-456',
			sink,
		);

		expect(sink).toHaveBeenCalledTimes(1);
		const published = sink.mock.calls[0][0];
		expect(published).toHaveLength(2);
		published.forEach((r) => {
			expect(r.kind).toBe('holiday');
			expect(r.absence_date).toBe('2026-05-01');
			expect(r.provider_id).toBe('provider-456');
		});
		expect(result.published).toBe(2);
	});
});
