import type { EnrichedJiraWorklog, GroupedWorklogs } from '../../../types/jira';
import { classifyWorklog } from './worklogClassifier';

export interface MonthlyReportState {
	issueSummaries: Record<string, string>;
	users: string[];
	userEmails: Record<string, string>;
	grouped: GroupedWorklogs;
	visibleEntries: [string, Record<string, EnrichedJiraWorklog[]>][];
}

/**
 * Resolve a stable user-key for grouping. Display name is preferred (most
 * UI surfaces show it as-is), but two distinct authors with the same
 * displayName must be disambiguated — otherwise the second author
 * silently overwrites the first in `userEmails` / `grouped`. We do that
 * by suffixing the email when a collision is detected (audit #47).
 *
 * The first-pass map `emailsByDisplayName` is built once before grouping
 * starts so the disambiguation is deterministic and applies to every
 * occurrence of the colliding name.
 */
function buildUserKey(
	displayName: string,
	email: string | undefined,
	emailsByDisplayName: Map<string, Set<string>>,
): string {
	const candidates = emailsByDisplayName.get(displayName);
	if (!candidates || candidates.size <= 1) return displayName;
	return email ? `${displayName} (${email})` : displayName;
}

export function deriveMonthlyReportState(
	data: EnrichedJiraWorklog[] | null,
	selectedUser: string,
	allowedUsersConfig: string,
): MonthlyReportState {
	const allowedEmails = allowedUsersConfig
		? allowedUsersConfig
				.split(',')
				.map((email) => email.trim().toLowerCase())
				.filter(Boolean)
		: [];

	// First pass: collect the set of emails seen per displayName so a
	// second-pass keying step can disambiguate collisions.
	const emailsByDisplayName = new Map<string, Set<string>>();
	for (const wl of data || []) {
		const name = wl.author?.displayName;
		const email = wl.author?.emailAddress?.toLowerCase();
		if (!name || !email) continue;
		const existing = emailsByDisplayName.get(name);
		if (existing) {
			existing.add(email);
		} else {
			emailsByDisplayName.set(name, new Set([email]));
		}
	}

	const issueSummaries: Record<string, string> = {};
	const userEmails: Record<string, string> = {};
	for (const wl of data || []) {
		const summary = wl.issue?.fields.summary;
		if (!summary) continue;
		issueSummaries[wl.issue.id] = summary;
		issueSummaries[wl.issue.key] = summary;
		const displayName = wl.author?.displayName;
		const email = wl.author?.emailAddress?.toLowerCase();
		if (displayName && email) {
			const userKey = buildUserKey(displayName, email, emailsByDisplayName);
			userEmails[userKey] = email;
		}
	}

	const isUserAllowed = (worklog: EnrichedJiraWorklog): boolean => {
		if (allowedEmails.length === 0) return true;
		const emailAddress = worklog.author?.emailAddress?.toLowerCase();
		return emailAddress ? allowedEmails.includes(emailAddress) : false;
	};

	const users: string[] = [];
	const uniqueUsers: Record<string, true> = {};
	for (const wl of data || []) {
		const displayName = wl.author?.displayName;
		const email = wl.author?.emailAddress?.toLowerCase();
		if (displayName && isUserAllowed(wl)) {
			uniqueUsers[buildUserKey(displayName, email, emailsByDisplayName)] = true;
		}
	}
	users.push(...Object.keys(uniqueUsers).sort((a, b) => a.localeCompare(b)));

	const grouped: GroupedWorklogs = {};
	for (const wl of data || []) {
		const displayName = wl.author?.displayName;
		const email = wl.author?.emailAddress?.toLowerCase();
		if (displayName && isUserAllowed(wl)) {
			const user = buildUserKey(displayName, email, emailsByDisplayName);
			const date = wl.classified?.loggedOn ?? classifyWorklog(wl).loggedOn;
			if (!date) continue;
			if (!grouped[user]) grouped[user] = {};
			if (!grouped[user][date]) grouped[user][date] = [];
			grouped[user][date].push(wl);
		}
	}

	const visibleEntries = Object.entries(grouped).filter(
		([user]) => selectedUser === '' || user === selectedUser,
	);

	return { issueSummaries, users, userEmails, grouped, visibleEntries };
}
