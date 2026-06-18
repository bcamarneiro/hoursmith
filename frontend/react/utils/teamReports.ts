import type { UserAbsenceDays } from '../../services/absenceService';
import type { WorklogItem } from '../../services/monthWorklogService';
import type { TeamMemberSummary } from '../../services/teamService';
import { addDaysToIsoDate } from './date';
import { sumWeekdayTargetSeconds } from './dayTarget';
import { classifyWorklog } from './worklogClassifier';

function toDateStr(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function isWeekday(dateStr: string): boolean {
	const date = new Date(dateStr);
	const day = date.getDay();
	return day !== 0 && day !== 6;
}

export function getWeekdaysBetween(start: string, end: string): string[] {
	const days: string[] = [];
	const current = new Date(start);
	const last = new Date(end);

	while (current <= last) {
		const dateStr = toDateStr(current);
		if (isWeekday(dateStr)) {
			days.push(dateStr);
		}
		current.setDate(current.getDate() + 1);
	}

	return days;
}

function parseAllowedUsers(allowedUsers: string): Set<string> | null {
	const entries = allowedUsers
		.split(',')
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean);
	return entries.length > 0 ? new Set(entries) : null;
}

export function buildTeamSummaries(
	worklogs: WorklogItem[],
	weekStart: string,
	weekEnd: string,
	allowedUsers: string,
	absenceDaysByUser?: UserAbsenceDays,
): TeamMemberSummary[] {
	const allowedSet = parseAllowedUsers(allowedUsers);
	const memberMap = new Map<
		string,
		{ displayName: string; dailySeconds: Map<string, number> }
	>();

	for (const worklog of worklogs) {
		const email = worklog.author?.emailAddress?.toLowerCase();
		if (!email) continue;
		if (allowedSet && !allowedSet.has(email)) continue;

		const c = classifyWorklog(worklog);
		const day = c.loggedOn;
		if (!day) continue;
		if (day < weekStart || day > weekEnd) continue;
		// Backdated worklogs don't count toward weekly totals — see
		// AGENTS.md ghost-reconciliation invariant.
		if (c.isBackdated) continue;

		let member = memberMap.get(email);
		if (!member) {
			member = {
				displayName: worklog.author?.displayName || email,
				dailySeconds: new Map(),
			};
			memberMap.set(email, member);
		}

		const existing = member.dailySeconds.get(day) || 0;
		member.dailySeconds.set(day, existing + (worklog.timeSpentSeconds ?? 0));
	}

	if (allowedSet) {
		for (const email of allowedSet) {
			if (!memberMap.has(email)) {
				memberMap.set(email, {
					displayName: email,
					dailySeconds: new Map(),
				});
			}
		}
	}

	// Weekly Reports targets the FULL week (8h/day → 40h for a standard 5-day
	// week), matching the canonical My Week model (suggestionMerger builds a
	// per-day target for every weekday in the week, with no "elapsed days only"
	// proration) and Monthly Reports. Previously this prorated the target down to
	// elapsed weekdays (excluding today + future), which made the same week read
	// "OK / no gap" here while My Week showed a large gap (ADA-443). The target
	// now spans the same weekdays the per-day totals are reported over.
	const weekdays = getWeekdaysBetween(weekStart, weekEnd);

	const summaries: TeamMemberSummary[] = [];
	for (const [email, member] of memberMap) {
		const dailyHours = new Map<string, number>();
		const totalSeconds = [...member.dailySeconds.values()].reduce(
			(sum, seconds) => sum + seconds,
			0,
		);
		const memberAbsenceMap = absenceDaysByUser?.get(email);
		const isAbsentOnDay = (day: string) => memberAbsenceMap?.has(day) ?? false;
		const loggedOnDay = (day: string) => member.dailySeconds.get(day) ?? 0;
		const targetSeconds = sumWeekdayTargetSeconds(
			weekdays,
			isAbsentOnDay,
			loggedOnDay,
		);
		const workedOnPtoDates: string[] = [];
		for (const day of weekdays) {
			if (isAbsentOnDay(day) && loggedOnDay(day) > 0) {
				workedOnPtoDates.push(day);
			}
		}

		for (const day of weekdays) {
			const seconds = member.dailySeconds.get(day) || 0;
			dailyHours.set(day, seconds / 3600);
		}

		summaries.push({
			email,
			displayName: member.displayName,
			dailyHours,
			totalSeconds,
			targetSeconds,
			gapSeconds: Math.max(0, targetSeconds - totalSeconds),
			workedOnPtoDates:
				workedOnPtoDates.length > 0 ? workedOnPtoDates : undefined,
		});
	}

	summaries.sort((a, b) => a.displayName.localeCompare(b.displayName));
	return summaries;
}

export interface TeamTrendPoint {
	weekStart: string;
	weekEnd: string;
	memberCount: number;
	totalSeconds: number;
	totalGapSeconds: number;
	complianceRate: number;
	attentionCount: number;
}

export interface RecurringGapMember {
	email: string;
	displayName: string;
	gapWeeks: number;
	currentGapSeconds: number;
	averageGapSeconds: number;
	currentLoggedSeconds: number;
}

export interface ManagerTrendModel {
	weeks: TeamTrendPoint[];
	averageComplianceRate: number;
	totalTrendGapSeconds: number;
	recurringGapMembers: RecurringGapMember[];
}

export function buildManagerTrendModel(
	worklogs: WorklogItem[],
	endWeekStart: string,
	trendWeeks: number,
	allowedUsers: string,
	absenceDaysByUser?: UserAbsenceDays,
): ManagerTrendModel {
	const weekStarts = Array.from({ length: trendWeeks }, (_, index) =>
		addDaysToIsoDate(endWeekStart, -7 * (trendWeeks - 1 - index)),
	);
	const weekSummaries = weekStarts.map((weekStart) => {
		const weekEnd = addDaysToIsoDate(weekStart, 6);
		const members = buildTeamSummaries(
			worklogs,
			weekStart,
			weekEnd,
			allowedUsers,
			absenceDaysByUser,
		);
		const totalSeconds = members.reduce(
			(sum, member) => sum + member.totalSeconds,
			0,
		);
		const totalGapSeconds = members.reduce(
			(sum, member) => sum + member.gapSeconds,
			0,
		);
		const compliantMembers = members.filter(
			(member) => member.gapSeconds === 0,
		).length;
		const complianceRate =
			members.length > 0
				? Math.round((compliantMembers / members.length) * 100)
				: 0;

		return {
			members,
			point: {
				weekStart,
				weekEnd,
				memberCount: members.length,
				totalSeconds,
				totalGapSeconds,
				complianceRate,
				attentionCount: members.filter((member) => member.gapSeconds > 0)
					.length,
			},
		};
	});

	const recurringMap = new Map<
		string,
		{
			displayName: string;
			gapWeeks: number;
			totalGapSeconds: number;
			currentGapSeconds: number;
			currentLoggedSeconds: number;
		}
	>();

	weekSummaries.forEach(({ members }, index) => {
		const isCurrentWeek = index === weekSummaries.length - 1;
		for (const member of members) {
			const existing = recurringMap.get(member.email) ?? {
				displayName: member.displayName,
				gapWeeks: 0,
				totalGapSeconds: 0,
				currentGapSeconds: 0,
				currentLoggedSeconds: 0,
			};

			if (member.gapSeconds > 0) {
				existing.gapWeeks += 1;
				existing.totalGapSeconds += member.gapSeconds;
			}

			if (isCurrentWeek) {
				existing.currentGapSeconds = member.gapSeconds;
				existing.currentLoggedSeconds = member.totalSeconds;
			}

			recurringMap.set(member.email, existing);
		}
	});

	const weeks = weekSummaries.map((item) => item.point);
	const recurringGapMembers = [...recurringMap.entries()]
		.map(([email, value]) => ({
			email,
			displayName: value.displayName,
			gapWeeks: value.gapWeeks,
			currentGapSeconds: value.currentGapSeconds,
			averageGapSeconds:
				value.gapWeeks > 0
					? Math.round(value.totalGapSeconds / value.gapWeeks)
					: 0,
			currentLoggedSeconds: value.currentLoggedSeconds,
		}))
		.filter((member) => member.gapWeeks > 1 || member.currentGapSeconds > 0)
		.sort((a, b) => {
			if (b.gapWeeks !== a.gapWeeks) return b.gapWeeks - a.gapWeeks;
			if (b.currentGapSeconds !== a.currentGapSeconds) {
				return b.currentGapSeconds - a.currentGapSeconds;
			}
			return a.displayName.localeCompare(b.displayName);
		});

	const averageComplianceRate =
		weeks.length > 0
			? Math.round(
					weeks.reduce((sum, week) => sum + week.complianceRate, 0) /
						weeks.length,
				)
			: 0;

	return {
		weeks,
		averageComplianceRate,
		totalTrendGapSeconds: weeks.reduce(
			(sum, week) => sum + week.totalGapSeconds,
			0,
		),
		recurringGapMembers,
	};
}
