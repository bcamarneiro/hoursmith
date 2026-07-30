/**
 * Domain-to-canonical mapping for the unified absence schema.
 *
 * Pure transformation functions that convert hoursmith domain objects
 * (CalendarFeed, AbsenceDay, AbsenceAssignment) into the canonical
 * shapes expected by the `absence_providers` and `user_absences` tables
 * (see premium/supabase/migrations/20260730000001_unified_absence_schema.sql).
 *
 * These are pure functions — no side effects, no I/O, no API calls.
 * Callers are responsible for providing valid UUIDs and timestamps.
 */

import type { AbsenceKind, AbsenceProviderType } from '@/../types/absence';
import type { AbsenceAssignment, CalendarFeed } from '@/stores/useConfigStore';
import type { AbsenceDay } from '@/services/absenceService';

// ---------------------------------------------------------------------------
// CalendarFeed → AbsenceProvider helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when a feed carries absence data rather than worklog
 * suggestions. Holiday feeds qualify because every holiday is an absence
 * day for every team member.
 */
export function isAbsenceProviderFeed(feed: CalendarFeed): boolean {
	return feed.type === 'absence' || feed.type === 'holiday';
}

/**
 * Maps a domain feed type to the canonical provider type discriminator.
 * Both `absence` and `holiday` feeds map to `'ics'` because they both
 * originate from ICS URLs; the distinction is preserved in the provider
 * config, not the provider type column.
 */
export function calendarFeedToProviderType(
	feed: CalendarFeed,
): AbsenceProviderType {
	switch (feed.type) {
		case 'absence':
			return 'ics';
		case 'holiday':
			return 'ics';
		default:
			return 'ics';
	}
}

/**
 * Extracts the provider-specific config bag from a `CalendarFeed`.
 *
 * The returned object is suitable for the `absence_providers.config` jsonb
 * column. It preserves:
 *  - feed type (`absence` / `holiday`)
 *  - attribution mode (only meaningful for absence feeds)
 *  - optional title filter
 *  - absence assignments (if any were associated at mapping time)
 */
export function calendarFeedToProviderConfig(
	feed: CalendarFeed,
	assignments?: AbsenceAssignment[],
): Record<string, unknown> {
	const config: Record<string, unknown> = {
		feedType: feed.type,
	};

	if (feed.absenceAttribution) {
		config.attribution = feed.absenceAttribution;
	}

	if (feed.titleFilter) {
		config.titleFilter = feed.titleFilter;
	}

	if (assignments && assignments.length > 0) {
		config.absenceAssignments = assignments;
	}

	return config;
}

// ---------------------------------------------------------------------------
// AbsenceDay → UserAbsence helpers
// ---------------------------------------------------------------------------

/** Shape returned by the absence-day mappers — insert-ready for `user_absences`. */
export interface UserAbsenceInput {
	userId: string;
	providerId: string | null;
	absenceDate: string;
	kind: AbsenceKind;
	reason: string;
	metadata: Record<string, unknown>;
}

const DEFAULT_METADATA: Record<string, unknown> = {};

/**
 * Converts a single `AbsenceDay` domain object into the canonical
 * `UserAbsence` insert shape.
 *
 * @param day          The domain absence day.
 * @param userId       The owning user id (UUID).
 * @param providerId   The parent provider id (UUID) or `null` for
 *                     manually-created absences.
 * @param extraContext Arbitrary caller-supplied metadata merged into
 *                     the `metadata` column (e.g. ICS uid, event summary).
 */
export function absenceDayToUserAbsenceInput(
	day: AbsenceDay,
	userId: string,
	providerId: string | null = null,
	extraContext: Record<string, unknown> = {},
): UserAbsenceInput {
	const reason = day.reasons.length > 0 ? day.reasons[0] : '';

	const metadata: Record<string, unknown> = { ...extraContext };
	if (day.reasons.length > 1) {
		metadata.allReasons = day.reasons;
	}

	if (Object.keys(metadata).length === 0) {
		// Re-use a shared empty object to reduce allocations on the hot path.
		return {
			userId,
			providerId,
			absenceDate: day.date,
			kind: day.kind,
			reason,
			metadata: DEFAULT_METADATA,
		};
	}

	return {
		userId,
		providerId,
		absenceDate: day.date,
		kind: day.kind,
		reason,
		metadata,
	};
}

/**
 * Batch version — maps an array of `AbsenceDay` objects to `UserAbsenceInput`
 * rows sharing the same user and provider.
 */
export function absenceDaysToUserAbsenceInputs(
	days: AbsenceDay[],
	userId: string,
	providerId: string | null = null,
	extraContext: Record<string, unknown> = {},
): UserAbsenceInput[] {
	return days.map((day) =>
		absenceDayToUserAbsenceInput(day, userId, providerId, extraContext),
	);
}

// ---------------------------------------------------------------------------
// AbsenceAssignment → config helpers
// ---------------------------------------------------------------------------

/**
 * Converts a list of `AbsenceAssignment` domain objects into a storable
 * config shape suitable for `absence_providers.config` (or as an argument
 * to `calendarFeedToProviderConfig`).
 */
export function absenceAssignmentsToConfigShape(
	assignments: AbsenceAssignment[],
): Record<string, unknown> {
	return {
		absenceAssignments: assignments,
	};
}
