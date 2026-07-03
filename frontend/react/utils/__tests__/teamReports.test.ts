import { describe, expect, it } from 'vitest';
import type { UserAbsenceDays } from '../../../services/absenceService';
import type { WorklogItem } from '../../../services/monthWorklogService';
import { buildManagerTrendModel, buildTeamSummaries } from '../teamReports';

function createWorklog(
	email: string,
	displayName: string,
	started: string,
	timeSpentSeconds: number,
	created?: string,
): WorklogItem {
	return {
		author: {
			emailAddress: email,
			displayName,
		},
		started,
		timeSpentSeconds,
		...(created ? { created } : {}),
		issue: {
			id: '10000',
			key: 'APP-1',
			fields: {
				summary: 'Trend work',
			},
		},
	};
}

describe('buildTeamSummaries', () => {
	it('includes allowed users with zero hours and calculates historical week targets', () => {
		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					'2026-03-03T09:00:00.000+0000',
					40 * 3600,
				),
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-04T09:00:00.000+0000',
					32 * 3600,
				),
			],
			'2026-03-02',
			'2026-03-08',
			'alice@example.com,bob@example.com,charlie@example.com',
		);

		expect(summaries.map((member) => member.displayName)).toEqual([
			'Alice',
			'Bob',
			'charlie@example.com',
		]);
		expect(summaries[0]?.gapSeconds).toBe(0);
		expect(summaries[1]?.gapSeconds).toBe(8 * 3600);
		expect(summaries[2]?.totalSeconds).toBe(0);
		expect(summaries[2]?.targetSeconds).toBe(40 * 3600);
	});

	it('targets the full week for the current week, matching My Week (ADA-443)', () => {
		// Regression for ADA-443: previously the current week's target was
		// prorated down to elapsed weekdays (excluding today + future), so a
		// member could read "OK / no gap" in weekly Reports while My Week (which
		// always targets the full 40h week) showed a large gap. The target must
		// now span all 5 weekdays regardless of where "today" falls.
		const now = new Date();
		const monday = new Date(now);
		// Move back to Monday of the current week (getDay: 0=Sun..6=Sat).
		const offsetToMonday = (now.getDay() + 6) % 7;
		monday.setDate(now.getDate() - offsetToMonday);
		const toIso = (d: Date) => {
			const y = d.getFullYear();
			const m = String(d.getMonth() + 1).padStart(2, '0');
			const day = String(d.getDate()).padStart(2, '0');
			return `${y}-${m}-${day}`;
		};
		const weekStart = toIso(monday);
		const sunday = new Date(monday);
		sunday.setDate(monday.getDate() + 6);
		const weekEnd = toIso(sunday);

		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					`${weekStart}T09:00:00.000+0000`,
					21.5 * 3600,
				),
			],
			weekStart,
			weekEnd,
			'alice@example.com',
		);

		// Full-week target (5 × 8h) regardless of which day "today" is, and the
		// gap reflects the same 40h expectation My Week uses.
		expect(summaries[0]?.targetSeconds).toBe(40 * 3600);
		expect(summaries[0]?.gapSeconds).toBe((40 - 21.5) * 3600);
	});

	it('prorates the colored gap to elapsed weekdays for the current week (ADA-477)', () => {
		// Week Mon 2026-03-02 .. Sun 2026-03-08. As of Tue 2026-03-03 only Mon+Tue
		// are owed (16h). Alice logged 8h: the full-week gap is 32h (context), but
		// the colored/prorated gap is only 8h (16h owed − 8h logged). This is what
		// stops the mid-week "everyone is behind" false alarm.
		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					'2026-03-02T09:00:00.000+0000',
					8 * 3600,
				),
			],
			'2026-03-02',
			'2026-03-08',
			'alice@example.com',
			undefined,
			'2026-03-03',
		);

		expect(summaries[0]?.targetSeconds).toBe(40 * 3600);
		expect(summaries[0]?.gapSeconds).toBe(32 * 3600);
		expect(summaries[0]?.expectedByTodaySeconds).toBe(16 * 3600);
		expect(summaries[0]?.proratedGapSeconds).toBe(8 * 3600);
	});

	it('does not flag a member behind before any weekday has elapsed (ADA-477)', () => {
		// asOf is the Sunday BEFORE the week — nothing is owed yet, so the colored
		// gap is 0 even though the full-week gap is the whole 40h.
		const summaries = buildTeamSummaries(
			[],
			'2026-03-02',
			'2026-03-08',
			'alice@example.com',
			undefined,
			'2026-03-01',
		);

		expect(summaries[0]?.gapSeconds).toBe(40 * 3600);
		expect(summaries[0]?.expectedByTodaySeconds).toBe(0);
		expect(summaries[0]?.proratedGapSeconds).toBe(0);
	});

	it('prorated gap equals the full gap once the week has fully elapsed (ADA-477)', () => {
		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-02T09:00:00.000+0000',
					32 * 3600,
				),
			],
			'2026-03-02',
			'2026-03-08',
			'bob@example.com',
			undefined,
			'2026-03-20',
		);

		expect(summaries[0]?.expectedByTodaySeconds).toBe(40 * 3600);
		expect(summaries[0]?.proratedGapSeconds).toBe(8 * 3600);
		expect(summaries[0]?.proratedGapSeconds).toBe(summaries[0]?.gapSeconds);
	});

	it('applies a per-user expected-hours override so a part-timer has no gap (ADA-392)', () => {
		// Bob is a 30h/week contractor → 6h/day. He logged 30h; with the default
		// 8h/day he'd show a 10h gap, but his override makes the target 30h → no
		// gap and no false "behind" colour.
		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					'2026-03-02T09:00:00.000+0000',
					40 * 3600,
				),
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-02T09:00:00.000+0000',
					30 * 3600,
				),
			],
			'2026-03-02',
			'2026-03-08',
			'alice@example.com,bob@example.com',
			undefined,
			'2026-03-20', // fully-elapsed week
			{ defaultDailyHours: 8, byUser: { 'bob@example.com': 6 } },
		);

		const alice = summaries.find((s) => s.email === 'alice@example.com');
		const bob = summaries.find((s) => s.email === 'bob@example.com');
		expect(alice?.targetSeconds).toBe(40 * 3600);
		expect(alice?.gapSeconds).toBe(0);
		expect(bob?.targetSeconds).toBe(30 * 3600);
		expect(bob?.gapSeconds).toBe(0);
		expect(bob?.proratedGapSeconds).toBe(0);
	});

	it('applies the team default daily hours when no override is set (ADA-392)', () => {
		// Team default of 6h/day → 30h week target for everyone without an override.
		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					'2026-03-02T09:00:00.000+0000',
					30 * 3600,
				),
			],
			'2026-03-02',
			'2026-03-08',
			'alice@example.com',
			undefined,
			'2026-03-20',
			{ defaultDailyHours: 6, byUser: {} },
		);

		expect(summaries[0]?.targetSeconds).toBe(30 * 3600);
		expect(summaries[0]?.gapSeconds).toBe(0);
	});

	it('excludes backdated worklogs from a member weekly total and gap', () => {
		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					'2026-03-03T09:00:00.000+0000',
					32 * 3600,
				),
				{
					...createWorklog(
						'alice@example.com',
						'Alice',
						'2026-03-04T09:00:00.000+0000',
						8 * 3600,
					),
					comment: 'Original Worklog Date was: 2026/02/15',
				} as WorklogItem,
			],
			'2026-03-02',
			'2026-03-08',
			'alice@example.com',
		);

		// Without the 8h backdated log Alice has 32h of 40h target.
		expect(summaries[0]?.totalSeconds).toBe(32 * 3600);
		expect(summaries[0]?.gapSeconds).toBe(8 * 3600);
	});

	it('reduces a member target when a shared absence assignment covers part of the week', () => {
		const absenceDaysByUser = new Map([
			[
				'bob@example.com',
				new Map([
					[
						'2026-03-05',
						{
							date: '2026-03-05',
							reasons: ['[Team PTO] Vacation - Bob'],
							kind: 'vacation' as const,
						},
					],
				]),
			],
		]);

		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-04T09:00:00.000+0000',
					32 * 3600,
				),
			],
			'2026-03-02',
			'2026-03-08',
			'bob@example.com',
			absenceDaysByUser,
		);

		expect(summaries[0]?.targetSeconds).toBe(32 * 3600);
		expect(summaries[0]?.gapSeconds).toBe(0);
	});

	it('keeps two distinct authors who share a displayName separate (ADA-458)', () => {
		// Same displayName, different accountId + email. Grouping must key on the
		// stable accountId so neither author silently overwrites the other.
		const summaries = buildTeamSummaries(
			[
				{
					author: {
						accountId: 'acct-1',
						emailAddress: 'alex.smith@example.com',
						displayName: 'Alex Smith',
					},
					started: '2026-03-03T09:00:00.000+0000',
					timeSpentSeconds: 40 * 3600,
					issue: { id: '1', key: 'APP-1', fields: { summary: 'x' } },
				} as WorklogItem,
				{
					author: {
						accountId: 'acct-2',
						emailAddress: 'alex.smith2@example.com',
						displayName: 'Alex Smith',
					},
					started: '2026-03-04T09:00:00.000+0000',
					timeSpentSeconds: 16 * 3600,
					issue: { id: '1', key: 'APP-1', fields: { summary: 'x' } },
				} as WorklogItem,
			],
			'2026-03-02',
			'2026-03-08',
			'', // no allow-list → both included
		);

		expect(summaries).toHaveLength(2);
		const totals = summaries.map((s) => s.totalSeconds).sort((a, b) => a - b);
		expect(totals).toEqual([16 * 3600, 40 * 3600]);
	});

	it('does not drop an author that has no emailAddress (ADA-458)', () => {
		const summaries = buildTeamSummaries(
			[
				{
					author: { accountId: 'acct-9', displayName: 'No Email User' },
					started: '2026-03-03T09:00:00.000+0000',
					timeSpentSeconds: 24 * 3600,
					issue: { id: '1', key: 'APP-1', fields: { summary: 'x' } },
				} as WorklogItem,
			],
			'2026-03-02',
			'2026-03-08',
			'', // no allow-list
		);

		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.displayName).toBe('No Email User');
		expect(summaries[0]?.totalSeconds).toBe(24 * 3600);
	});
});

describe('buildManagerTrendModel', () => {
	it('builds recurring gap signals across multiple weeks', () => {
		const model = buildManagerTrendModel(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					'2026-03-03T09:00:00.000+0000',
					40 * 3600,
				),
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-04T09:00:00.000+0000',
					32 * 3600,
				),
				createWorklog(
					'alice@example.com',
					'Alice',
					'2026-03-10T09:00:00.000+0000',
					40 * 3600,
				),
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-11T09:00:00.000+0000',
					24 * 3600,
				),
			],
			'2026-03-09',
			2,
			'alice@example.com,bob@example.com',
		);

		expect(model.weeks).toHaveLength(2);
		expect(model.weeks[0]).toMatchObject({
			weekStart: '2026-03-02',
			complianceRate: 50,
			attentionCount: 1,
		});
		expect(model.weeks[1]).toMatchObject({
			weekStart: '2026-03-09',
			complianceRate: 50,
			attentionCount: 1,
		});
		expect(model.averageComplianceRate).toBe(50);
		expect(model.recurringGapMembers).toEqual([
			{
				email: 'bob@example.com',
				displayName: 'Bob',
				gapWeeks: 2,
				currentGapSeconds: 16 * 3600,
				averageGapSeconds: 12 * 3600,
				currentLoggedSeconds: 24 * 3600,
			},
		]);
	});

	it('floors complianceRate so it never reads 100 while a member has a gap (ADA-458)', () => {
		// 7 of 8 members fully logged, 1 short. 7/8 = 87.5% → floor 87 (a round
		// would inflate to 88). The point: a fractional rate that rounds up must
		// not let the "all compliant" threshold (100) be reached spuriously.
		const worklogs: WorklogItem[] = [];
		const emails: string[] = [];
		for (let i = 0; i < 8; i++) {
			const email = `user${i}@example.com`;
			emails.push(email);
			// Last member logs only 8h (gap), the rest log a full 40h week.
			const hours = i === 7 ? 8 : 40;
			worklogs.push(
				createWorklog(
					email,
					`User ${i}`,
					'2026-03-02T09:00:00.000+0000',
					hours * 3600,
				),
			);
		}

		const model = buildManagerTrendModel(
			worklogs,
			'2026-03-02',
			1,
			emails.join(','),
		);

		expect(model.weeks[0]?.complianceRate).toBe(87);
		expect(model.weeks[0]?.attentionCount).toBe(1);
	});

	it('uses reduced targets when absences are attributed during the trend window', () => {
		// Bob took Wednesday off (2026-03-11) and logged 8h on each of the
		// other four weekdays. Per-day target rule: absent day = 0 (no work
		// logged), workdays = 8h each → weekly target = 32h, matches logged.
		const absenceDaysByUser = new Map([
			[
				'bob@example.com',
				new Map([
					[
						'2026-03-11',
						{
							date: '2026-03-11',
							reasons: ['[Team PTO] Vacation - Bob'],
							kind: 'vacation' as const,
						},
					],
				]),
			],
		]);

		const model = buildManagerTrendModel(
			[
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-09T09:00:00.000+0000',
					8 * 3600,
				),
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-10T09:00:00.000+0000',
					8 * 3600,
				),
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-12T09:00:00.000+0000',
					8 * 3600,
				),
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-13T09:00:00.000+0000',
					8 * 3600,
				),
			],
			'2026-03-09',
			1,
			'bob@example.com',
			absenceDaysByUser,
		);

		expect(model.weeks[0]?.totalGapSeconds).toBe(0);
		expect(model.weeks[0]?.complianceRate).toBe(100);
	});

	it('reduces target for multiple users when a shared/team absence map is passed', () => {
		// Shared-feed style: absenceDaysByUser holds entries for several users
		// keyed by their email (as `fetchAbsenceDaysByUser` produces).
		const absenceDaysByUser: UserAbsenceDays = new Map();
		absenceDaysByUser.set(
			'alice@example.com',
			new Map([
				[
					'2026-03-04',
					{
						date: '2026-03-04',
						reasons: ['[Team PTO] Vacation - Alice'],
						kind: 'vacation',
					},
				],
			]),
		);
		absenceDaysByUser.set(
			'bob@example.com',
			new Map([
				[
					'2026-03-05',
					{
						date: '2026-03-05',
						reasons: ['[Team PTO] Sick - Bob'],
						kind: 'sick',
					},
				],
			]),
		);

		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					'2026-03-02T09:00:00.000+0000',
					8 * 3600,
				),
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-02T09:00:00.000+0000',
					8 * 3600,
				),
			],
			'2026-03-02',
			'2026-03-08',
			'alice@example.com,bob@example.com',
			absenceDaysByUser,
		);

		const alice = summaries.find((s) => s.email === 'alice@example.com');
		const bob = summaries.find((s) => s.email === 'bob@example.com');
		// Each has 4 weekdays × 8h = 32h target (one weekday absorbed).
		expect(alice?.targetSeconds).toBe(32 * 3600);
		expect(bob?.targetSeconds).toBe(32 * 3600);
	});

	it('flags workedOnPtoDates when a member logs work on an absence day', () => {
		const absenceDaysByUser = new Map([
			[
				'alice@example.com',
				new Map([
					[
						'2026-03-04',
						{
							date: '2026-03-04',
							reasons: ['[Team PTO] Vacation - Alice'],
							kind: 'vacation' as const,
						},
					],
				]),
			],
		]);

		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					'2026-03-04T09:00:00.000+0000',
					4 * 3600,
				),
			],
			'2026-03-02',
			'2026-03-08',
			'alice@example.com',
			absenceDaysByUser,
		);

		expect(summaries[0]?.workedOnPtoDates).toEqual(['2026-03-04']);
	});

	it('omits workedOnPtoDates when no absence/work conflict exists', () => {
		const summaries = buildTeamSummaries(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					'2026-03-04T09:00:00.000+0000',
					4 * 3600,
				),
			],
			'2026-03-02',
			'2026-03-08',
			'alice@example.com',
		);

		expect(summaries[0]?.workedOnPtoDates).toBeUndefined();
	});

	it('partial-day absence: target tracks logged hours (100% compliant)', () => {
		// New per-day target rule: Bob worked 4h on his absence day. Target
		// for that day = min(logged, 8h) = 4h. Other 4 workdays unworked
		// (would be missing). Total target = 4*8 + 4 = 36h. Bob logged 4h,
		// so gap = 32h.
		const absenceDaysByUser = new Map([
			[
				'bob@example.com',
				new Map([
					[
						'2026-03-11',
						{
							date: '2026-03-11',
							reasons: ['[Team PTO] Vacation - Bob'],
							kind: 'vacation' as const,
						},
					],
				]),
			],
		]);

		const model = buildManagerTrendModel(
			[
				createWorklog(
					'bob@example.com',
					'Bob',
					'2026-03-11T09:00:00.000+0000',
					4 * 3600,
				),
			],
			'2026-03-09',
			1,
			'bob@example.com',
			absenceDaysByUser,
		);

		expect(model.weeks[0]?.totalSeconds).toBe(4 * 3600);
		expect(model.weeks[0]?.totalGapSeconds).toBe(32 * 3600);
	});

	it('excludes Pattern B jira-native backdates from weekly totals entirely', () => {
		// Started 2025-09-28, created 2025-10-06 (different month) — classifier
		// flags this as a backdated submission. Per the project-wide invariant,
		// backdated worklogs never contribute to a week's total. They show as
		// ghosts/side notes in the UI and remain in CSV exports for finance.
		const model = buildManagerTrendModel(
			[
				createWorklog(
					'alice@example.com',
					'Alice',
					'2025-09-28T10:00:00.000Z',
					4 * 3600,
					'2025-10-06T10:00:00.000Z',
				),
			],
			'2025-10-06',
			3,
			'alice@example.com',
		);

		expect(model.weeks.map((week) => week.weekStart)).toEqual([
			'2025-09-22',
			'2025-09-29',
			'2025-10-06',
		]);
		// Not counted on loggedOn week...
		expect(model.weeks[2]?.totalSeconds).toBe(0);
		// ...and not counted on intendedFor week either.
		expect(model.weeks[1]?.totalSeconds).toBe(0);
		expect(model.weeks[0]?.totalSeconds).toBe(0);
	});
});
