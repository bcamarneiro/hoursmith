/**
 * eventMatcher.ts — Pure user-matching logic for calendar events.
 *
 * Given a calendar event summary, feed configuration, and absence assignments,
 * determines which user(s) the event should count for.
 *
 * Three modes:
 * - `self` ::   the current user only (with optional title filter)
 * - `shared` :: users whose assignment patterns match the event summary
 * - holiday feeds :: nationwide (all users) or regional (assignments with matching patterns)
 *
 * Extracted from the original inline logic in `absenceService.ts` (ADA-644).
 *
 * @module
 */

import type { AbsenceAssignment, CalendarFeed } from '../stores/useConfigStore';

// --- Types ---

/**
 * A normalised assignment with trimmed patterns and deduplicated lowercased emails.
 * Empty patterns or user-lists are filtered out during normalisation.
 */
export interface NormalisedAssignment {
	pattern: string;
	userEmails: string[];
}

/** Absence attribution mode for a calendar feed. */
export type AbsenceAttribution = 'self' | 'shared';

/**
 * Result of matching a holiday event.
 *
 * - `regional`: Map of matched user emails → reason (one entry per matched user).
 * - `isNational`: `true` when no assignment pattern matched the event summary,
 *   meaning the event should apply to all known users (nationwide default).
 */
export interface HolidayMatchResult {
	regional: Map<string, string[]>;
	isNational: boolean;
}

// --- Constants ---

const VALID_ABSENCE_TYPES = new Set<CalendarFeed['type']>([
	'absence',
	'holiday',
]);

// --- Normalisation ---

/**
 * Normalise raw AbsenceAssignment[] into a clean list.
 * Trims patterns, lowercases and deduplicates emails, filters out empty entries.
 */
export function normalizeAssignments(
	assignments: AbsenceAssignment[],
): NormalisedAssignment[] {
	return assignments
		.map((assignment) => ({
			pattern: assignment.pattern.trim(),
			userEmails: [
				...new Set(
					assignment.userEmails
						.map((email) => email.trim().toLowerCase())
						.filter((email) => email.length > 0),
				),
			],
		}))
		.filter(
			(assignment) =>
				assignment.pattern.length > 0 && assignment.userEmails.length > 0,
		);
}

// --- Title filter ---

/**
 * Check whether the event summary matches a feed's title filter.
 * A missing or empty filter matches everything.
 */
export function matchesTitleFilter(
	summary: string,
	titleFilter?: string,
): boolean {
	if (!titleFilter?.trim()) return true;
	return summary.toLowerCase().includes(titleFilter.trim().toLowerCase());
}

// --- Absence feed matching ---

/**
 * Find users whose assignment patterns match the event summary.
 * Matching is case-insensitive substring against the summary.
 */
export function findMatchedUsers(
	summary: string,
	assignments: NormalisedAssignment[],
): string[] {
	const matched = assignments.filter((assignment) =>
		summary.toLowerCase().includes(assignment.pattern.toLowerCase()),
	);
	const out = new Set<string>();
	for (const a of matched) {
		for (const email of a.userEmails) {
			out.add(email);
		}
	}
	return [...out];
}

/**
 * Determine the set of users an absence-feed event applies to.
 *
 * @param eventSummary - The VEVENT summary / JSON event title.
 * @param attribution - `'self'` (current user only) or `'shared'` (pattern-matched).
 * @param assignments - Normalised absence assignment list.
 * @param currentUserEmail - The current user's email (lowered inside).
 * @param titleFilter - Optional feed-level title filter.
 * @returns A `Set` of matched user emails.
 */
export function matchEventToUsers(
	eventSummary: string,
	attribution: AbsenceAttribution,
	assignments: NormalisedAssignment[],
	currentUserEmail: string,
	titleFilter?: string,
): Set<string> {
	const matched = new Set<string>();

	if (!matchesTitleFilter(eventSummary, titleFilter)) {
		return matched;
	}

	if (attribution === 'shared') {
		for (const user of findMatchedUsers(eventSummary, assignments)) {
			matched.add(user);
		}
	} else {
		// 'self' attribution
		const normalizedEmail = currentUserEmail.trim().toLowerCase();
		if (normalizedEmail) {
			matched.add(normalizedEmail);
		}
	}

	return matched;
}

// --- Holiday feed matching ---

/**
 * Match a holiday event to users.
 *
 * Processes assignments to find patterns matching the event summary.
 * When a match is found the holiday is **regional** (scoped to those users).
 * When no match is found the holiday is **nationwide** (`isNational: true`)
 *
 * @param eventSummary - The holiday event summary/title.
 * @param assignments - Normalised absence assignments (regional patterns).
 * @param label - Feed label (prepended to the reason string).
 * @returns A {@link HolidayMatchResult} with regional matches and nationwide flag.
 */
export function matchHolidayEvent(
	eventSummary: string,
	assignments: NormalisedAssignment[],
	label?: string,
): HolidayMatchResult {
	const regional = new Map<string, string[]>();
	const reason = label ? `[${label}] ${eventSummary}` : eventSummary;

	const matchedUsers = findMatchedUsers(eventSummary, assignments);

	if (matchedUsers.length > 0) {
		for (const email of matchedUsers) {
			const existing = regional.get(email);
			if (existing) {
				if (!existing.includes(reason)) {
					existing.push(reason);
				}
			} else {
				regional.set(email, [reason]);
			}
		}
	}

	return {
		regional,
		isNational: matchedUsers.length === 0,
	};
}

/**
 * Collect the final set of holiday recipients after all feeds have been processed.
 *
 * Nationwide holidays apply to every user known from other feeds plus the
 * current user. This mirrors the existing logic in `absenceService.fetchAbsenceDaysByUser`.
 *
 * @param knownUsers - Set of user emails already seen from absence/regional feeds.
 * @param currentUserEmail - The current user's email.
 * @returns A deduplicated set of recipient emails.
 */
export function collectHolidayRecipients(
	knownUsers: Set<string>,
	currentUserEmail: string,
): Set<string> {
	const recipients = new Set<string>(knownUsers);
	const normalizedEmail = currentUserEmail.trim().toLowerCase();
	if (normalizedEmail) {
		recipients.add(normalizedEmail);
	}
	return recipients;
}
