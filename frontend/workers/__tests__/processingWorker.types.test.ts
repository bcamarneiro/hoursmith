import { describe, expect, it } from 'vitest';
import type { AbsenceDay, UserAbsenceDays } from '../../services/absenceService';
import type { TeamMemberSummary } from '../../services/teamService';
import {
	serializeUserAbsenceDays,
	deserializeUserAbsenceDays,
	serializeAbsenceMap,
	deserializeAbsenceMap,
	serializeTeamSummaries,
	deserializeTeamSummaries,
} from '../processingWorker.types';

describe('serializeUserAbsenceDays', () => {
	it('returns undefined for undefined input', () => {
		expect(serializeUserAbsenceDays(undefined)).toBeUndefined();
	});

	it('serializes nested Maps to entry arrays', () => {
		const absenceDay: AbsenceDay = { kind: 'pto', hours: 8 };
		const map: UserAbsenceDays = new Map([
			['user@example.com', new Map([['2025-01-15', absenceDay]])],
		]);

		const serialized = serializeUserAbsenceDays(map);
		expect(serialized).toEqual([
			['user@example.com', [['2025-01-15', absenceDay]]],
		]);
	});

	it('handles multiple users and days', () => {
		const map: UserAbsenceDays = new Map([
			[
				'user1@example.com',
				new Map([
					['2025-01-15', { kind: 'pto', hours: 8 }],
					['2025-01-16', { kind: 'holiday', hours: 8 }],
				]),
			],
			['user2@example.com', new Map([['2025-01-17', { kind: 'sick', hours: 4 }]])],
		]);

		const serialized = serializeUserAbsenceDays(map);
		expect(serialized).toHaveLength(2);
		expect(serialized![0][1]).toHaveLength(2);
		expect(serialized![1][1]).toHaveLength(1);
	});
});

describe('deserializeUserAbsenceDays', () => {
	it('returns undefined for undefined input', () => {
		expect(deserializeUserAbsenceDays(undefined)).toBeUndefined();
	});

	it('reconstructs nested Maps from entry arrays', () => {
		const serialized: [string, [string, AbsenceDay][]][] = [
			['user@example.com', [['2025-01-15', { kind: 'pto', hours: 8 }]]],
		];

		const deserialized = deserializeUserAbsenceDays(serialized);
		expect(deserialized).toBeInstanceOf(Map);
		expect(deserialized!.get('user@example.com')).toBeInstanceOf(Map);
		expect(deserialized!.get('user@example.com')!.get('2025-01-15')).toEqual({
			kind: 'pto',
			hours: 8,
		});
	});

	it('round-trips through serialize/deserialize', () => {
		const original: UserAbsenceDays = new Map([
			[
				'user@example.com',
				new Map([
					['2025-01-15', { kind: 'pto', hours: 8 }],
					['2025-01-16', { kind: 'holiday', hours: 4 }],
				]),
			],
		]);

		const serialized = serializeUserAbsenceDays(original);
		const deserialized = deserializeUserAbsenceDays(serialized);

		expect(deserialized!.size).toBe(1);
		expect(deserialized!.get('user@example.com')!.size).toBe(2);
		expect(deserialized!.get('user@example.com')!.get('2025-01-15')).toEqual({
			kind: 'pto',
			hours: 8,
		});
	});
});

describe('serializeAbsenceMap', () => {
	it('returns undefined for undefined input', () => {
		expect(serializeAbsenceMap(undefined)).toBeUndefined();
	});

	it('serializes Map to entry array', () => {
		const map = new Map<string, AbsenceDay>([
			['2025-01-15', { kind: 'pto', hours: 8 }],
		]);

		const serialized = serializeAbsenceMap(map);
		expect(serialized).toEqual([['2025-01-15', { kind: 'pto', hours: 8 }]]);
	});
});

describe('deserializeAbsenceMap', () => {
	it('returns undefined for undefined input', () => {
		expect(deserializeAbsenceMap(undefined)).toBeUndefined();
	});

	it('reconstructs Map from entry array', () => {
		const serialized: [string, AbsenceDay][] = [
			['2025-01-15', { kind: 'pto', hours: 8 }],
		];

		const deserialized = deserializeAbsenceMap(serialized);
		expect(deserialized).toBeInstanceOf(Map);
		expect(deserialized!.get('2025-01-15')).toEqual({ kind: 'pto', hours: 8 });
	});
});

describe('serializeTeamSummaries', () => {
	it('converts TeamMemberSummary Maps to entry arrays', () => {
		const summaries: TeamMemberSummary[] = [
			{
				email: 'user@example.com',
				displayName: 'User',
				dailyHours: new Map([
					['2025-01-15', 8],
					['2025-01-16', 7.5],
				]),
				totalSeconds: 55800,
				targetSeconds: 57600,
				gapSeconds: 1800,
				backdatedSeconds: 3600,
				workedOnPtoDates: ['2025-01-15'],
			},
		];

		const serialized = serializeTeamSummaries(summaries);
		expect(serialized).toHaveLength(1);
		expect(serialized[0].dailyHours).toEqual([
			['2025-01-15', 8],
			['2025-01-16', 7.5],
		]);
		expect(serialized[0].email).toBe('user@example.com');
		expect(serialized[0].totalSeconds).toBe(55800);
	});
});

describe('deserializeTeamSummaries', () => {
	it('reconstructs TeamMemberSummary with Maps', () => {
		const serialized = [
			{
				email: 'user@example.com',
				displayName: 'User',
				dailyHours: [
					['2025-01-15', 8],
					['2025-01-16', 7.5],
				] as [string, number][],
				totalSeconds: 55800,
				targetSeconds: 57600,
				gapSeconds: 1800,
				backdatedSeconds: 3600,
				workedOnPtoDates: ['2025-01-15'],
			},
		];

		const deserialized = deserializeTeamSummaries(serialized);
		expect(deserialized).toHaveLength(1);
		expect(deserialized[0].dailyHours).toBeInstanceOf(Map);
		expect(deserialized[0].dailyHours.get('2025-01-15')).toBe(8);
		expect(deserialized[0].dailyHours.get('2025-01-16')).toBe(7.5);
		expect(deserialized[0].email).toBe('user@example.com');
	});

	it('round-trips through serialize/deserialize', () => {
		const original: TeamMemberSummary[] = [
			{
				email: 'user@example.com',
				displayName: 'User',
				dailyHours: new Map([
					['2025-01-15', 8],
					['2025-01-16', 7.5],
				]),
				totalSeconds: 55800,
				targetSeconds: 57600,
				gapSeconds: 1800,
				backdatedSeconds: 3600,
				workedOnPtoDates: ['2025-01-15'],
			},
		];

		const serialized = serializeTeamSummaries(original);
		const deserialized = deserializeTeamSummaries(serialized);

		expect(deserialized).toHaveLength(1);
		expect(deserialized[0].dailyHours).toBeInstanceOf(Map);
		expect(deserialized[0].dailyHours.size).toBe(2);
		expect(deserialized[0].dailyHours.get('2025-01-15')).toBe(8);
		expect(deserialized[0].totalSeconds).toBe(55800);
		expect(deserialized[0].workedOnPtoDates).toEqual(['2025-01-15']);
	});
});
