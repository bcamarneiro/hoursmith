/**
 * absenceEventMapper.ts — Transform expanded date entries into canonical
 * UserAbsenceUpsert records.
 *
 * This module sits between providers (which produce parsed events) and the
 * persistence layer (user_absences table / cron pipeline). It handles the
 * transformation and user-matching steps but does NOT parse raw ICS text
 * or expand recurrence — those are the provider's concern.
 *
 * ## Pipeline
 *
 *   ParsedCalendarEvent[]
 *         ↓ (provider.expand)
 *   ExpandedDateEntry[]   ← mapped by this module
 *         ↓ (eventMatcher + classifyAbsenceKind)
 *   UserAbsenceUpsert[]   ← ready for publishing
 *         ↓ (absencePublisher — ADA-718)
 *   sink / user_absences pipeline
 *
 * The `map*AndPublish` wrappers invoke the publisher (absencePublisher) upon
 * successful mapping, with try/catch, logging, and fail-safe fallbacks.
 *
 * @module
 */

import type { AbsenceKind } from '../../types/absence';
import type { UserAbsenceUpsert } from './absences';
import { classifyAbsenceKind } from './absenceService';
import {
	type AbsencePublishResult,
	type AbsencePublishSink,
	mapAndPublish,
} from './absencePublisher';
import {
	type NormalisedAssignment,
	collectHolidayRecipients,
	matchHolidayEvent,
	normalizeAssignments,
} from './eventMatcher';

// --- Re-exports for convenience ---

export { classifyAbsenceKind, normalizeAssignments };
export type { NormalisedAssignment };

// --- Types ---

/**
 * A date entry already expanded to a single calendar day.
 * Produced by providers' expand functions.
 */
export interface ExpandedDateEntry {
	/** YYYY-MM-DD date string. */
	date: string;
	/** Event summary / title from the calendar source. */
	summary: string;
}

// --- Absence feed mapping ---

/**
 * Map expanded date entries to UserAbsenceUpsert records for a set of
 * matched users.
 *
 * Each (user, date) pair produces one record. The absence kind is inferred
 * from the event summary via classifyAbsenceKind.
 *
 * @param entries       - Expanded date entries (within query range).
 * @param matchedUsers  - Target user emails (from eventMatcher matching).
 * @param label         - Feed label (prepended as `[Label] summary`).
 * @param providerId    - Optional upstream provider id for the FK.
 * @returns Canonical upsert records.
 */
export function mapDatesToAbsenceRecords(
	entries: ExpandedDateEntry[],
	matchedUsers: Set<string>,
	label?: string,
	providerId?: string,
): UserAbsenceUpsert[] {
	const records: UserAbsenceUpsert[] = [];

	for (const { date, summary } of entries) {
		const reason = label ? `[${label}] ${summary}` : summary;
		const kind = classifyAbsenceKind(summary);

		for (const userEmail of matchedUsers) {
			records.push({
				user_id: userEmail,
				provider_id: providerId ?? null,
				absence_date: date,
				kind,
				reason,
			});
		}
	}

	return records;
}

// --- Holiday feed mapping ---

/**
 * Map a holiday feed's expanded dates into UserAbsenceUpsert records.
 *
 * For each expanded entry the eventMatcher determines whether the holiday
 * is regional (scoped to matched assignment users) or nationwide (applies
 * to all known users + current user).
 *
 * @param entries           - Expanded date entries for the holiday feed.
 * @param assignments       - Normalised assignment patterns (regional scoping).
 * @param knownUsers        - Known user emails (nationwide fallback).
 * @param currentUserEmail  - Current user email (nationwide fallback).
 * @param label             - Feed label (prepended to reasons).
 * @param providerId        - Optional upstream provider id for the FK.
 * @returns Canonical upsert records.
 */
export function mapHolidayDatesToRecords(
	entries: ExpandedDateEntry[],
	assignments: NormalisedAssignment[],
	knownUsers: Set<string>,
	currentUserEmail: string,
	label?: string,
	providerId?: string,
): UserAbsenceUpsert[] {
	const records: UserAbsenceUpsert[] = [];
	const nationwideDates: { date: string; reason: string }[] = [];

	for (const { date, summary } of entries) {
		const match = matchHolidayEvent(summary, assignments, label);

		if (match.isNational) {
			const reason = label ? `[${label}] ${summary}` : summary;
			nationwideDates.push({ date, reason });
		} else {
			for (const [email, reasons] of match.regional) {
				for (const reason of reasons) {
					records.push({
						user_id: email,
						provider_id: providerId ?? null,
						absence_date: date,
						kind: 'holiday' as AbsenceKind,
						reason,
					});
				}
			}
		}
	}

	// Apply nationwide dates to all known users + current user.
	if (nationwideDates.length > 0) {
		const recipients = collectHolidayRecipients(knownUsers, currentUserEmail);
		for (const { date, reason } of nationwideDates) {
			for (const email of recipients) {
				records.push({
					user_id: email,
					provider_id: providerId ?? null,
					absence_date: date,
					kind: 'holiday' as AbsenceKind,
					reason,
				});
			}
		}
	}

	return records;
}

// --- Map + publish integration (ADA-718) ---

/**
 * Map absence-feed entries and publish the resulting records on success.
 *
 * Wraps `mapDatesToAbsenceRecords` with the publisher: mapping errors are
 * contained (logged, reported, never thrown) and the sink is only invoked
 * once mapping has succeeded. See absencePublisher for the fail-safe
 * guarantees.
 */
export async function mapDatesAndPublish(
	entries: ExpandedDateEntry[],
	matchedUsers: Set<string>,
	label?: string,
	providerId?: string,
	sink?: AbsencePublishSink,
): Promise<AbsencePublishResult> {
	return mapAndPublish(
		() => mapDatesToAbsenceRecords(entries, matchedUsers, label, providerId),
		sink,
	);
}

/**
 * Map holiday-feed entries and publish the resulting records on success.
 *
 * Wraps `mapHolidayDatesToRecords` with the publisher — same fail-safe
 * semantics as `mapDatesAndPublish`.
 */
export async function mapHolidayDatesAndPublish(
	entries: ExpandedDateEntry[],
	assignments: NormalisedAssignment[],
	knownUsers: Set<string>,
	currentUserEmail: string,
	label?: string,
	providerId?: string,
	sink?: AbsencePublishSink,
): Promise<AbsencePublishResult> {
	return mapAndPublish(
		() =>
			mapHolidayDatesToRecords(
				entries,
				assignments,
				knownUsers,
				currentUserEmail,
				label,
				providerId,
			),
		sink,
	);
}
