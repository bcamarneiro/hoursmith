import type { UserAbsenceDays } from '../../services/absenceService';
import type { WorklogItem } from '../../services/monthWorklogService';
import type { TeamMemberSummary } from '../../services/teamService';
import {
	addDaysToIsoDate,
	isWeekend,
	parseIsoDateLocal,
	toLocalDateString,
} from './date';
import { sumWeekdayTargetSeconds } from './dayTarget';
import { deriveOnTimeStatus } from './onTimeStatus';
import { classifyWorklog } from './worklogClassifier';

function isWeekday(dateStr: string): boolean {
	return !isWeekend(dateStr);
}

export function getWeekdaysBetween(start: string, end: string): string[] {
	const days: string[] = [];
	// Parse the bounds as local dates (parseIsoDateLocal) rather than via
	// `new Date(string)`, which interprets a bare YYYY-MM-DD as UTC midnight and
	// then drifts a day when read back in a negative-offset timezone (ADA-457).
	const current = parseIsoDateLocal(start);
	const last = parseIsoDateLocal(end);

	while (current <= last) {
		const dateStr = toLocalDateString(current);
		if (isWeekday(dateStr)) {
			days.push(dateStr);
		}
		current.setDate(current.getDate() + 1);
	}

	return days;
}

/**
 * Per-user working-hours configuration (ADA-392). `defaultDailyHours` is the
 * team-wide per-weekday target; `byUser` maps a lowercased email to a
 * per-person override so contractors / part-timers get an accurate target
 * rather than being perpetually flagged red.
 */
export interface ExpectedHoursConfig {
	defaultDailyHours: number;
	byUser: Record<string, number>;
}

const DEFAULT_DAILY_HOURS = 8;

function resolveDailyTargetSeconds(
	email: string,
	expectedHours: ExpectedHoursConfig | undefined,
): number {
	const perUser = email ? expectedHours?.byUser?.[email] : undefined;
	const hours =
		perUser ?? expectedHours?.defaultDailyHours ?? DEFAULT_DAILY_HOURS;
	return hours * 3600;
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
	// The "as of" date used to prorate the colored gap to elapsed weekdays.
	// Defaults to today; injected in tests. Pure enough — only used for a
	// `<=` weekday comparison, never for grouping/bucketing.
	asOf: string = toLocalDateString(new Date()),
	// Per-user working-hours config (ADA-392). When omitted, every member gets
	// the 8h/weekday baseline (behaviour unchanged from before this feature).
	expectedHours?: ExpectedHoursConfig,
	// Weekly deadline (ADA-387). When provided, each member gets an on-time
	// classification from whether their worklogs were *created* by this instant.
	// `now` decides whether a still-incomplete member reads "pending" (deadline
	// ahead) or "incomplete" (deadline passed). Both omitted → no on-time fields.
	deadline?: Date,
	now: Date = new Date(),
): TeamMemberSummary[] {
	const allowedSet = parseAllowedUsers(allowedUsers);
	const deadlineMs = deadline ? deadline.getTime() : null;
	const deadlinePassed = deadline ? now.getTime() > deadline.getTime() : false;
	// Group on a STABLE key so we never (a) drop authors that have no
	// emailAddress, nor (b) merge two distinct people who share a displayName
	// (ADA-458). Preference: accountId → email → a clearly-marked synthetic
	// fallback. `email` is still tracked separately because it drives the
	// absence-map lookup and the downstream summary field.
	const memberMap = new Map<
		string,
		{
			displayName: string;
			email: string;
			dailySeconds: Map<string, number>;
			onTimeSeconds: number;
		}
	>();

	let fallbackKeySeq = 0;
	const fallbackKeyByWorklog = new WeakMap<object, string>();

	for (const worklog of worklogs) {
		const email = worklog.author?.emailAddress?.toLowerCase();
		const accountId = worklog.author?.accountId;
		if (allowedSet) {
			// Allow-list filtering is email-based; an author with no email can't
			// match the allow-list, so skip it when a list is configured.
			if (!email || !allowedSet.has(email)) continue;
		}

		const c = classifyWorklog(worklog);
		const day = c.loggedOn;
		if (!day) continue;
		if (day < weekStart || day > weekEnd) continue;
		// Backdated worklogs don't count toward weekly totals — see
		// AGENTS.md ghost-reconciliation invariant.
		if (c.isBackdated) continue;

		let groupKey: string;
		if (accountId) {
			groupKey = `acct:${accountId}`;
		} else if (email) {
			groupKey = `email:${email}`;
		} else {
			// No stable identifier at all: keep this author visible but never
			// merge them with anyone else. Derive a per-author synthetic key
			// (stable across this worklog object's repeats only — distinct
			// authors get distinct keys).
			let synthetic = fallbackKeyByWorklog.get(worklog as object);
			if (!synthetic) {
				synthetic = `unknown:${fallbackKeySeq++}`;
				fallbackKeyByWorklog.set(worklog as object, synthetic);
			}
			groupKey = synthetic;
		}

		let member = memberMap.get(groupKey);
		if (!member) {
			member = {
				displayName: worklog.author?.displayName || email || 'Unknown user',
				email: email ?? '',
				dailySeconds: new Map(),
				onTimeSeconds: 0,
			};
			memberMap.set(groupKey, member);
		}

		const seconds = worklog.timeSpentSeconds ?? 0;
		const existing = member.dailySeconds.get(day) || 0;
		member.dailySeconds.set(day, existing + seconds);

		// On-time accounting (ADA-387): a worklog counts as "on time" when it was
		// created on or before the deadline. A missing `created` can't be proven
		// late, so it's treated as on-time. Backdated worklogs already `continue`d
		// above, so they never reach here.
		if (deadlineMs !== null) {
			const createdMs = worklog.created
				? new Date(worklog.created).getTime()
				: null;
			if (createdMs === null || createdMs <= deadlineMs) {
				member.onTimeSeconds += seconds;
			}
		}
	}

	if (allowedSet) {
		for (const email of allowedSet) {
			const key = `email:${email}`;
			// An allowed user already grouped by accountId is present under an
			// `acct:` key; only add a placeholder if no row references this email.
			const alreadyPresent = [...memberMap.values()].some(
				(m) => m.email === email,
			);
			if (!alreadyPresent) {
				memberMap.set(key, {
					displayName: email,
					email,
					dailySeconds: new Map(),
					onTimeSeconds: 0,
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
	// Weekdays that have already elapsed by `asOf`. For a past week this is every
	// weekday (so prorated == full); for the current week it's Mon..today, which
	// is what stops the "everyone red on Monday" false alarm (ADA-477).
	const elapsedWeekdays = weekdays.filter((day) => day <= asOf);

	const summaries: TeamMemberSummary[] = [];
	for (const member of memberMap.values()) {
		const email = member.email;
		const dailyHours = new Map<string, number>();
		const totalSeconds = [...member.dailySeconds.values()].reduce(
			(sum, seconds) => sum + seconds,
			0,
		);
		const memberAbsenceMap = email ? absenceDaysByUser?.get(email) : undefined;
		const isAbsentOnDay = (day: string) => memberAbsenceMap?.has(day) ?? false;
		const loggedOnDay = (day: string) => member.dailySeconds.get(day) ?? 0;
		// Per-user daily target (ADA-392): the lead's override for this member, or
		// the team default, or the 8h baseline. Drives both the full-week target
		// and the prorated one, so gap / completeness % / RAG are all correct for
		// part-timers instead of always red.
		const dailyTargetSeconds = resolveDailyTargetSeconds(email, expectedHours);
		const targetSeconds = sumWeekdayTargetSeconds(
			weekdays,
			isAbsentOnDay,
			loggedOnDay,
			dailyTargetSeconds,
		);
		// Prorated "expected by today" target + gap — the colored signal. Keeps
		// the full-week target/gap above as the week-completion context.
		const expectedByTodaySeconds = sumWeekdayTargetSeconds(
			elapsedWeekdays,
			isAbsentOnDay,
			loggedOnDay,
			dailyTargetSeconds,
		);
		const proratedGapSeconds = Math.max(
			0,
			expectedByTodaySeconds - totalSeconds,
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

		// On-time classification (ADA-387) — only when a deadline was supplied.
		const onTimeSeconds = deadline ? member.onTimeSeconds : undefined;
		const onTimeStatus = deadline
			? deriveOnTimeStatus({
					targetSeconds,
					totalSeconds,
					onTimeSeconds: member.onTimeSeconds,
					deadlinePassed,
				})
			: undefined;

		summaries.push({
			email,
			displayName: member.displayName,
			dailyHours,
			totalSeconds,
			targetSeconds,
			gapSeconds: Math.max(0, targetSeconds - totalSeconds),
			expectedByTodaySeconds,
			proratedGapSeconds,
			onTimeSeconds,
			onTimeStatus,
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
	asOf: string = toLocalDateString(new Date()),
	expectedHours?: ExpectedHoursConfig,
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
			asOf,
			expectedHours,
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
		// Floor (not round) so a near-complete team can never display "100%"
		// while a member still has a gap — e.g. 199/200 = 99.5 would round up
		// to 100 and contradict the gap signal (ADA-458). 100% is reserved for
		// a genuinely gap-free team (compliantMembers === members.length).
		const complianceRate =
			members.length > 0
				? Math.floor((compliantMembers / members.length) * 100)
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
			email: string;
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
			// Email-less members would all collide on '' — fall back to the
			// displayName so distinct unknown-email authors aren't merged.
			const key = member.email || `name:${member.displayName}`;
			const existing = recurringMap.get(key) ?? {
				email: member.email,
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

			recurringMap.set(key, existing);
		}
	});

	const weeks = weekSummaries.map((item) => item.point);
	const recurringGapMembers = [...recurringMap.values()]
		.map((value) => ({
			email: value.email,
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
