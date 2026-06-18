import type { WorklogItem } from '../../services/monthWorklogService';
import type { TeamMemberSummary } from '../../services/teamService';
import { classifyWorklog } from './worklogClassifier';

export interface ReportsConsistencyMismatch {
	email: string;
	displayName: string;
	weeklySeconds: number;
	monthlySeconds: number;
}

export interface ReportsConsistencyResult {
	matches: boolean;
	checkedUsers: number;
	mismatches: ReportsConsistencyMismatch[];
}

function parseAllowedUsers(allowedUsers: string): Set<string> | null {
	const entries = allowedUsers
		.split(',')
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean);

	return entries.length > 0 ? new Set(entries) : null;
}

export function validateReportsConsistency(
	teamMembers: TeamMemberSummary[],
	worklogs: WorklogItem[],
	weekStart: string,
	weekEnd: string,
	allowedUsers: string,
): ReportsConsistencyResult {
	const allowedSet = parseAllowedUsers(allowedUsers);
	const weeklyMap = new Map(
		teamMembers.map((member) => [
			member.email.toLowerCase(),
			{
				displayName: member.displayName,
				seconds: member.totalSeconds,
			},
		]),
	);

	const monthlyMap = new Map<
		string,
		{ displayName: string; seconds: number }
	>();
	for (const worklog of worklogs) {
		const email = worklog.author?.emailAddress?.toLowerCase();
		if (!email) continue;
		if (allowedSet && !allowedSet.has(email)) continue;

		const classified = classifyWorklog(worklog);
		// Backdated worklogs never contribute to weekly/monthly totals anywhere
		// in the app (buildTeamSummaries and the Monthly Reports view + CSV both
		// drop them — see the ghost-reconciliation invariant). The consistency
		// check must use the SAME canonical aggregation, otherwise a backdated
		// log that the weekly source excludes but this side counted would show a
		// false "Inconsistent" (ADA-449).
		if (classified.isBackdated) continue;

		const day = classified.loggedOn;
		if (!day) continue;
		if (day < weekStart || day > weekEnd) continue;

		const existing = monthlyMap.get(email);
		if (existing) {
			existing.seconds += worklog.timeSpentSeconds ?? 0;
			continue;
		}

		monthlyMap.set(email, {
			displayName: worklog.author?.displayName || email,
			seconds: worklog.timeSpentSeconds ?? 0,
		});
	}

	if (allowedSet) {
		for (const email of allowedSet) {
			if (!weeklyMap.has(email)) {
				weeklyMap.set(email, { displayName: email, seconds: 0 });
			}
			if (!monthlyMap.has(email)) {
				monthlyMap.set(email, { displayName: email, seconds: 0 });
			}
		}
	}

	const emails = new Set([...weeklyMap.keys(), ...monthlyMap.keys()]);
	const mismatches: ReportsConsistencyMismatch[] = [];

	for (const email of emails) {
		const weekly = weeklyMap.get(email) ?? { displayName: email, seconds: 0 };
		const monthly = monthlyMap.get(email) ?? { displayName: email, seconds: 0 };

		if (weekly.seconds !== monthly.seconds) {
			mismatches.push({
				email,
				displayName: weekly.displayName || monthly.displayName || email,
				weeklySeconds: weekly.seconds,
				monthlySeconds: monthly.seconds,
			});
		}
	}

	return {
		matches: mismatches.length === 0,
		checkedUsers: emails.size,
		mismatches: mismatches.sort((a, b) =>
			a.displayName.localeCompare(b.displayName),
		),
	};
}
