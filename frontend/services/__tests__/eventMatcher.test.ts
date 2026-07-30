import { describe, expect, it } from 'vitest';
import {
	collectHolidayRecipients,
	findMatchedUsers,
	matchEventToUsers,
	matchHolidayEvent,
	matchesTitleFilter,
	normalizeAssignments,
} from '../eventMatcher';

describe('normalizeAssignments', () => {
	it('trims patterns and lowercases emails', () => {
		const result = normalizeAssignments([
			{ pattern: '  Bruno C  ', userEmails: ['Bruno@Example.com'] },
		]);
		expect(result).toEqual([
			{ pattern: 'Bruno C', userEmails: ['bruno@example.com'] },
		]);
	});

	it('filters out empty patterns', () => {
		const result = normalizeAssignments([
			{ pattern: '  ', userEmails: ['alice@example.com'] },
			{ pattern: 'Bruno C', userEmails: ['bruno@example.com'] },
		]);
		expect(result).toHaveLength(1);
		expect(result[0].pattern).toBe('Bruno C');
	});

	it('filters out empty user lists', () => {
		const result = normalizeAssignments([
			{ pattern: 'Bruno C', userEmails: [] },
			{ pattern: 'Alice', userEmails: ['alice@example.com'] },
		]);
		expect(result).toHaveLength(1);
		expect(result[0].pattern).toBe('Alice');
	});

	it('filters out entries where all emails are whitespace', () => {
		const result = normalizeAssignments([
			{ pattern: 'Nobody', userEmails: ['   '] },
		]);
		expect(result).toHaveLength(0);
	});

	it('deduplicates emails within a single assignment', () => {
		const result = normalizeAssignments([
			{
				pattern: 'Bruno C',
				userEmails: ['bruno@example.com', 'BRUNO@EXAMPLE.COM'],
			},
		]);
		expect(result).toEqual([
			{ pattern: 'Bruno C', userEmails: ['bruno@example.com'] },
		]);
	});

	it('returns an empty array for empty input', () => {
		expect(normalizeAssignments([])).toEqual([]);
	});
});

describe('matchesTitleFilter', () => {
	it('returns true when no filter is provided', () => {
		expect(matchesTitleFilter('Anything')).toBe(true);
	});

	it('returns true when filter is empty string', () => {
		expect(matchesTitleFilter('Anything', '')).toBe(true);
	});

	it('returns true when filter is whitespace', () => {
		expect(matchesTitleFilter('Anything', '   ')).toBe(true);
	});

	it('returns true on case-insensitive substring match', () => {
		expect(matchesTitleFilter('Bruno C - Vacation', 'bruno')).toBe(true);
	});

	it('returns false when no match', () => {
		expect(matchesTitleFilter('Daniel D - Sick', 'bruno')).toBe(false);
	});

	it('matches after trimming the filter', () => {
		expect(matchesTitleFilter('Alice - Off', '  alice  ')).toBe(true);
	});
});

describe('findMatchedUsers', () => {
	const assignments = [
		{ pattern: 'Bruno C', userEmails: ['bruno@example.com'] },
		{ pattern: 'Daniel D', userEmails: ['daniel@example.com'] },
		{ pattern: 'Team All', userEmails: ['alice@example.com', 'bob@example.com'] },
	];

	it('matches a single user by pattern', () => {
		expect(findMatchedUsers('Bruno C - Vacation', assignments)).toEqual([
			'bruno@example.com',
		]);
	});

	it('matches multiple users from a single pattern', () => {
		const result = findMatchedUsers('Team All - Standup', assignments);
		expect(result).toEqual(
			expect.arrayContaining(['alice@example.com', 'bob@example.com']),
		);
		expect(result).toHaveLength(2);
	});

	it('returns empty array when no pattern matches', () => {
		expect(
			findMatchedUsers('Unrelated Event - Training', assignments),
		).toEqual([]);
	});

	it('is case-insensitive', () => {
		expect(findMatchedUsers('bruno c - vacation', assignments)).toEqual([
			'bruno@example.com',
		]);
	});

	it('returns empty array for empty assignments', () => {
		expect(findMatchedUsers('Bruno C - Vacation', [])).toEqual([]);
	});
});

describe('matchEventToUsers', () => {
	const assignments = [
		{ pattern: 'Bruno C', userEmails: ['bruno@example.com'] },
		{ pattern: 'Daniel D', userEmails: ['daniel@example.com'] },
	];

	it('assigns to self when attribution is self with no filter', () => {
		const result = matchEventToUsers(
			'Bruno C - Vacation',
			'self',
			assignments,
			'bruno@example.com',
		);
		expect([...result]).toEqual(['bruno@example.com']);
	});

	it('assigns to self when attribution is self with matching filter', () => {
		const result = matchEventToUsers(
			'Bruno C - Vacation',
			'self',
			assignments,
			'bruno@example.com',
			'Bruno',
		);
		expect([...result]).toEqual(['bruno@example.com']);
	});

	it('returns empty when self attribution does not match title filter', () => {
		const result = matchEventToUsers(
			'Daniel D - Sick',
			'self',
			assignments,
			'bruno@example.com',
			'Bruno',
		);
		expect(result.size).toBe(0);
	});

	it('returns empty when current user email is empty', () => {
		const result = matchEventToUsers(
			'Anything',
			'self',
			assignments,
			'',
		);
		expect(result.size).toBe(0);
	});

	it('matches shared pattern to specific users', () => {
		const result = matchEventToUsers(
			'Bruno C - Vacation',
			'shared',
			assignments,
			'anyone@example.com',
		);
		expect([...result]).toEqual(['bruno@example.com']);
	});

	it('returns empty for shared attribution with no matching pattern', () => {
		const result = matchEventToUsers(
			'Unrelated Training',
			'shared',
			assignments,
			'anyone@example.com',
		);
		expect(result.size).toBe(0);
	});

	it('returns empty for shared attribution when title filter excludes the event', () => {
		const result = matchEventToUsers(
			'Daniel D - Sick',
			'shared',
			assignments,
			'anyone@example.com',
			'Bruno',
		);
		expect(result.size).toBe(0);
	});

	it('matches multiple users via shared pattern', () => {
		const teamAssignments = [
			{ pattern: 'Team Standup', userEmails: ['alice@example.com', 'bob@example.com'] },
		];
		const result = matchEventToUsers(
			'Team Standup - Daily',
			'shared',
			teamAssignments,
			'anyone@example.com',
		);
		expect(result.size).toBe(2);
		expect(result.has('alice@example.com')).toBe(true);
		expect(result.has('bob@example.com')).toBe(true);
	});
});

describe('matchHolidayEvent', () => {
	const assignments = [
		{ pattern: 'Lisbon', userEmails: ['alice@example.com', 'bob@example.com'] },
		{ pattern: 'Porto', userEmails: ['carla@example.com'] },
	];

	it('returns regional matches when a pattern matches the summary', () => {
		const result = matchHolidayEvent('Lisbon Day', assignments);
		expect(result.isNational).toBe(false);
		expect([...result.regional.keys()]).toEqual(
			expect.arrayContaining(['alice@example.com', 'bob@example.com']),
		);
	});

	it('marks as national when no pattern matches', () => {
		const result = matchHolidayEvent('Labour Day', assignments);
		expect(result.isNational).toBe(true);
		expect(result.regional.size).toBe(0);
	});

	it('prepends label to the reason when provided', () => {
		const result = matchHolidayEvent('Lisbon Day', assignments, 'PT Holidays');
		const reasons = result.regional.get('alice@example.com');
		expect(reasons).toBeDefined();
		expect(reasons![0]).toBe('[PT Holidays] Lisbon Day');
	});

	it('uses raw summary as reason when no label is provided', () => {
		const result = matchHolidayEvent('Lisbon Day', assignments);
		const reasons = result.regional.get('alice@example.com');
		expect(reasons).toBeDefined();
		expect(reasons![0]).toBe('Lisbon Day');
	});

	it('is case-insensitive in pattern matching', () => {
		const result = matchHolidayEvent('lisbon DAY', assignments);
		expect(result.isNational).toBe(false);
		expect(result.regional.has('alice@example.com')).toBe(true);
	});

	it('does not duplicate the same reason for the same user', () => {
		const result = matchHolidayEvent(
			'Lisbon Day',
			[
				{ pattern: 'Lisbon', userEmails: ['alice@example.com'] },
				{ pattern: 'Day', userEmails: ['alice@example.com'] },
			],
		);
		const reasons = result.regional.get('alice@example.com');
		expect(reasons).toHaveLength(1); // Deduplicated
	});
});

describe('collectHolidayRecipients', () => {
	it('includes all known users plus current user', () => {
		const result = collectHolidayRecipients(
			new Set(['alice@example.com', 'bob@example.com']),
			'carol@example.com',
		);
		expect([...result]).toEqual(
			expect.arrayContaining([
				'alice@example.com',
				'bob@example.com',
				'carol@example.com',
			]),
		);
	});

	it('adds current user even when known users is empty', () => {
		const result = collectHolidayRecipients(
			new Set(),
			'solo@example.com',
		);
		expect(result.size).toBe(1);
		expect(result.has('solo@example.com')).toBe(true);
	});

	it('lowercases the current user email', () => {
		const result = collectHolidayRecipients(
			new Set(),
			'Solo@Example.com',
		);
		expect(result.has('solo@example.com')).toBe(true);
	});

	it('does not add an empty-string current user', () => {
		const result = collectHolidayRecipients(
			new Set(['alice@example.com']),
			'',
		);
		expect(result.size).toBe(1);
	});
});
