import { describe, expect, it } from 'vitest';
import {
	absenceAssignmentsToConfigShape,
	absenceDaysToUserAbsenceInputs,
	absenceDayToUserAbsenceInput,
	calendarFeedToProviderConfig,
	calendarFeedToProviderType,
	isAbsenceProviderFeed,
} from '../absenceDomainMapper';
import type { AbsenceDay } from '@/services/absenceService';
import type { AbsenceAssignment, CalendarFeed } from '@/stores/useConfigStore';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = '11111111-1111-1111-1111-111111111111';
const PROVIDER_ID = '22222222-2222-2222-2222-222222222222';

function makeFeed(overrides: Partial<CalendarFeed> = {}): CalendarFeed {
	return {
		label: 'Team Absences',
		url: 'https://example.com/calendar.ics',
		type: 'absence',
		absenceAttribution: 'shared',
		titleFilter: 'Vacation',
		...overrides,
	};
}

function makeAssignment(
	overrides: Partial<AbsenceAssignment> = {},
): AbsenceAssignment {
	return {
		pattern: 'Bruno C',
		userEmails: ['bruno@example.com'],
		...overrides,
	};
}

function makeDay(overrides: Partial<AbsenceDay> = {}): AbsenceDay {
	return {
		date: '2026-07-31',
		reasons: ['[Team vacations] Bruno C - Vacation'],
		kind: 'vacation',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// isAbsenceProviderFeed
// ---------------------------------------------------------------------------

describe('isAbsenceProviderFeed', () => {
	it('returns true for an absence feed', () => {
		expect(isAbsenceProviderFeed(makeFeed({ type: 'absence' }))).toBe(true);
	});

	it('returns true for a holiday feed', () => {
		expect(isAbsenceProviderFeed(makeFeed({ type: 'holiday' }))).toBe(true);
	});

	it('returns false for a suggestion feed', () => {
		expect(isAbsenceProviderFeed(makeFeed({ type: 'suggestion' }))).toBe(false);
	});

	it('returns true for absence feed without attribution (holiday-like)', () => {
		const feed = makeFeed({
			type: 'absence',
			absenceAttribution: undefined,
		});
		expect(isAbsenceProviderFeed(feed)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// calendarFeedToProviderType
// ---------------------------------------------------------------------------

describe('calendarFeedToProviderType', () => {
	it('maps absence to ics', () => {
		expect(calendarFeedToProviderType(makeFeed({ type: 'absence' }))).toBe(
			'ics',
		);
	});

	it('maps holiday to ics', () => {
		expect(calendarFeedToProviderType(makeFeed({ type: 'holiday' }))).toBe(
			'ics',
		);
	});

	it('maps suggestion to ics (caller-gated — isAbsenceProviderFeed should filter first)', () => {
		expect(calendarFeedToProviderType(makeFeed({ type: 'suggestion' }))).toBe(
			'ics',
		);
	});
});

// ---------------------------------------------------------------------------
// calendarFeedToProviderConfig
// ---------------------------------------------------------------------------

describe('calendarFeedToProviderConfig', () => {
	it('preserves feedType in config', () => {
		const config = calendarFeedToProviderConfig(makeFeed({ type: 'holiday' }));
		expect(config.feedType).toBe('holiday');
	});

	it('preserves absenceAttribution when present', () => {
		const config = calendarFeedToProviderConfig(
			makeFeed({ absenceAttribution: 'self' }),
		);
		expect(config.attribution).toBe('self');
	});

	it('preserves titleFilter when present', () => {
		const config = calendarFeedToProviderConfig(
			makeFeed({ titleFilter: 'PTO' }),
		);
		expect(config.titleFilter).toBe('PTO');
	});

	it('omits attribution from config when absent', () => {
		const config = calendarFeedToProviderConfig(
			makeFeed({ absenceAttribution: undefined }),
		);
		expect(config).not.toHaveProperty('attribution');
	});

	it('omits titleFilter from config when absent', () => {
		const config = calendarFeedToProviderConfig(
			makeFeed({ titleFilter: undefined }),
		);
		expect(config).not.toHaveProperty('titleFilter');
	});

	it('appends absenceAssignments when provided', () => {
		const assignments = [makeAssignment()];
		const config = calendarFeedToProviderConfig(makeFeed(), assignments);
		expect(config.absenceAssignments).toEqual(assignments);
	});

	it('omits absenceAssignments when empty array is passed', () => {
		const config = calendarFeedToProviderConfig(makeFeed(), []);
		expect(config).not.toHaveProperty('absenceAssignments');
	});

	it('omits absenceAssignments when undefined is passed', () => {
		const config = calendarFeedToProviderConfig(makeFeed(), undefined);
		expect(config).not.toHaveProperty('absenceAssignments');
	});

	it('returns a config with exactly the expected keys for a minimal feed', () => {
		const config = calendarFeedToProviderConfig(
			makeFeed({
				absenceAttribution: undefined,
				titleFilter: undefined,
			}),
		);
		expect(Object.keys(config).sort()).toEqual(['feedType']);
	});
});

// ---------------------------------------------------------------------------
// absenceDayToUserAbsenceInput
// ---------------------------------------------------------------------------

describe('absenceDayToUserAbsenceInput', () => {
	it('maps all required fields', () => {
		const day = makeDay({ date: '2026-07-31', kind: 'vacation' });
		const result = absenceDayToUserAbsenceInput(day, USER_ID, PROVIDER_ID);

		expect(result.userId).toBe(USER_ID);
		expect(result.providerId).toBe(PROVIDER_ID);
		expect(result.absenceDate).toBe('2026-07-31');
		expect(result.kind).toBe('vacation');
	});

	it('uses the first reason as the primary reason string', () => {
		const day = makeDay({
			reasons: ['[Team] Alice - PTO', '(Holiday)'],
		});
		const result = absenceDayToUserAbsenceInput(day, USER_ID);

		expect(result.reason).toBe('[Team] Alice - PTO');
	});

	it('stores all reasons in metadata when there are multiple', () => {
		const reasons = ['primary reason', 'secondary reason', 'tertiary'];
		const day = makeDay({ reasons });
		const result = absenceDayToUserAbsenceInput(day, USER_ID);

		expect(result.metadata.allReasons).toEqual(reasons);
	});

	it('does not add allReasons to metadata when there is a single reason', () => {
		const day = makeDay({ reasons: ['only one reason'] });
		const result = absenceDayToUserAbsenceInput(day, USER_ID);

		expect(result.metadata).toEqual({});
	});

	it('returns empty reason for an empty reasons array', () => {
		const day = makeDay({ reasons: [] });
		const result = absenceDayToUserAbsenceInput(day, USER_ID);

		expect(result.reason).toBe('');
	});

	it('returns empty metadata for empty reasons array', () => {
		const day = makeDay({ reasons: [] });
		const result = absenceDayToUserAbsenceInput(day, USER_ID);

		expect(result.metadata).toEqual({});
	});

	it('defaults providerId to null when omitted', () => {
		const day = makeDay();
		const result = absenceDayToUserAbsenceInput(day, USER_ID);

		expect(result.providerId).toBeNull();
	});

	it('merges extraContext into metadata', () => {
		const day = makeDay({ reasons: ['single'] });
		const result = absenceDayToUserAbsenceInput(day, USER_ID, null, {
			icsUid: 'abc-123',
			eventSummary: 'Vacation',
		});

		expect(result.metadata).toEqual({
			icsUid: 'abc-123',
			eventSummary: 'Vacation',
		});
	});

	it('merges extraContext with allReasons when both are present', () => {
		const day = makeDay({ reasons: ['primary', 'secondary'] });
		const result = absenceDayToUserAbsenceInput(day, USER_ID, PROVIDER_ID, {
			icsUid: 'uid-1',
		});

		expect(result.metadata).toEqual({
			icsUid: 'uid-1',
			allReasons: ['primary', 'secondary'],
		});
	});

	it('preserves all AbsenceKind values', () => {
		const kinds: Array<AbsenceDay['kind']> = [
			'vacation',
			'sick',
			'off',
			'holiday',
		];
		for (const kind of kinds) {
			const day = makeDay({ kind });
			const result = absenceDayToUserAbsenceInput(day, USER_ID);
			expect(result.kind).toBe(kind);
		}
	});

	it('returns a fresh metadata object each call (mutation safety)', () => {
		const day = makeDay({ reasons: ['single reason'] });
		const result1 = absenceDayToUserAbsenceInput(day, USER_ID);
		const result2 = absenceDayToUserAbsenceInput(day, USER_ID);

		// Mutate metadata on the first result
		(result1.metadata as Record<string, unknown>).polluted = true;

		// Second result must NOT see the mutation
		expect(result2.metadata).toEqual({});
		expect(result2.metadata).not.toHaveProperty('polluted');
	});

	it('handles date format consistently', () => {
		const dates = ['2026-01-01', '2026-12-31', '2026-02-28'];
		for (const date of dates) {
			const day = makeDay({ date });
			const result = absenceDayToUserAbsenceInput(day, USER_ID);
			expect(result.absenceDate).toBe(date);
		}
	});
});

// ---------------------------------------------------------------------------
// absenceDaysToUserAbsenceInputs
// ---------------------------------------------------------------------------

describe('absenceDaysToUserAbsenceInputs', () => {
	it('maps an empty array to an empty array', () => {
		const result = absenceDaysToUserAbsenceInputs([], USER_ID);
		expect(result).toEqual([]);
	});

	it('maps a single day correctly', () => {
		const days = [makeDay({ date: '2026-08-01' })];
		const result = absenceDaysToUserAbsenceInputs(days, USER_ID, PROVIDER_ID);

		expect(result).toHaveLength(1);
		expect(result[0].absenceDate).toBe('2026-08-01');
		expect(result[0].userId).toBe(USER_ID);
		expect(result[0].providerId).toBe(PROVIDER_ID);
	});

	it('maps multiple days preserving order', () => {
		const days = [
			makeDay({ date: '2026-08-01', kind: 'vacation' as const }),
			makeDay({ date: '2026-08-02', kind: 'sick' as const }),
			makeDay({ date: '2026-08-03', kind: 'off' as const }),
		];
		const result = absenceDaysToUserAbsenceInputs(days, USER_ID);

		expect(result).toHaveLength(3);
		expect(result[0].absenceDate).toBe('2026-08-01');
		expect(result[0].kind).toBe('vacation');
		expect(result[1].absenceDate).toBe('2026-08-02');
		expect(result[1].kind).toBe('sick');
		expect(result[2].absenceDate).toBe('2026-08-03');
		expect(result[2].kind).toBe('off');
	});

	it('passes extraContext to every row', () => {
		const days = [
			makeDay({ date: '2026-08-01', reasons: ['r1'] }),
			makeDay({ date: '2026-08-02', reasons: ['r2'] }),
		];
		const result = absenceDaysToUserAbsenceInputs(days, USER_ID, PROVIDER_ID, {
			providerLabel: 'Team Cal',
		});

		expect(result).toHaveLength(2);
		expect(result[0].metadata.providerLabel).toBe('Team Cal');
		expect(result[1].metadata.providerLabel).toBe('Team Cal');
	});
});

// ---------------------------------------------------------------------------
// absenceAssignmentsToConfigShape
// ---------------------------------------------------------------------------

describe('absenceAssignmentsToConfigShape', () => {
	it('wraps a single assignment', () => {
		const assignments = [makeAssignment({ pattern: 'Alice' })];
		const config = absenceAssignmentsToConfigShape(assignments);

		expect(config.absenceAssignments).toEqual(assignments);
	});

	it('wraps multiple assignments', () => {
		const assignments = [
			makeAssignment({ pattern: 'Alice' }),
			makeAssignment({
				pattern: 'Bob',
				userEmails: ['bob@example.com', 'bob2@example.com'],
			}),
		];
		const config = absenceAssignmentsToConfigShape(assignments);

		expect(config.absenceAssignments).toHaveLength(2);
		expect(config.absenceAssignments).toEqual(assignments);
	});

	it('wraps an empty array', () => {
		const config = absenceAssignmentsToConfigShape([]);
		expect(config.absenceAssignments).toEqual([]);
	});

	it('output always has exactly one key', () => {
		const config = absenceAssignmentsToConfigShape([makeAssignment()]);
		expect(Object.keys(config)).toEqual(['absenceAssignments']);
	});
});
