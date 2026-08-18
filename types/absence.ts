export type AbsenceKind = 'vacation' | 'sick' | 'off' | 'holiday';

/** Provider types for the unified absence schema. */
export type AbsenceProviderType = 'ics' | 'manual';

/** Mirrors the public.absence_providers database row. */
export interface AbsenceProvider {
	id: string;
	userId: string;
	providerType: AbsenceProviderType;
	label: string;
	url: string | null;
	config: Record<string, unknown>;
	enabled: boolean;
	createdAt: string; // ISO 8601
	updatedAt: string; // ISO 8601
}

/** Mirrors the public.user_absences database row. */
export interface UserAbsence {
	id: string;
	userId: string;
	providerId: string | null;
	absenceDate: string; // YYYY-MM-DD
	kind: AbsenceKind;
	reason: string;
	metadata: Record<string, unknown>;
	createdAt: string; // ISO 8601
	updatedAt: string; // ISO 8601
}

// ─── Domain types (computed / aggregated) ────────────────────────────

/**
 * An aggregated absence day derived from one or more calendar feeds.
 *
 * The `reasons` array captures every reason contributed by each data source
 * (e.g. multiple ICS feeds, manual entries) so downstream consumers can
 * display all sources or pick the highest-priority one.
 *
 * This is the shape returned by `fetchAbsenceDays` / `fetchAbsenceDaysByUser`
 * and consumed by CSV exports, team reports, and the absence summary UI.
 */
export interface AbsenceDay {
	/** The absence date in YYYY-MM-DD format. */
	date: string;
	/** Every reason contributed by all data sources for this date. */
	reasons: string[];
	/** The highest-priority absence kind across all sources for this date. */
	kind: AbsenceKind;
}

/**
 * Full absence map returned by `fetchAbsenceDaysByUser`.
 *
 * Outer key: user email (lowercased).
 * Inner key: date string (YYYY-MM-DD).
 * Inner value: the aggregated `AbsenceDay` for that user on that date.
 *
 * Example:
 *   absenceDaysByUser.get("alice@example.com")?.get("2026-07-31")?.kind
 */
export type UserAbsenceDays = Map<string, Map<string, AbsenceDay>>;

// ─── Record type (persistent entity) ─────────────────────────────────

/**
 * Canonical absence record — the persistent, user-facing entity that
 * represents a single day of absence.
 *
 * `AbsenceRecord` combines the stored database fields (`UserAbsence`) with
 * the computed aggregation (`AbsenceDay.reasons`) into one self-contained
 * type. Every field has a clear source:
 *
 * | Field     | Source                          |
 * |-----------|---------------------------------|
 * | id        | user_absences.id                |
 * | userId    | user_absences.user_id           |
 * | date      | user_absences.absence_date      |
 * | kind      | user_absences.kind              |
 * | reasons   | aggregated from all providers   |
 * | metadata  | user_absences.metadata          |
 * | createdAt | user_absences.created_at        |
 * | updatedAt | user_absences.updated_at        |
 *
 * Applications should prefer `AbsenceRecord` over the bare `UserAbsence`
 * DB row when they need a complete, display-ready view of an absence day.
 */
export interface AbsenceRecord {
	/** Unique record identifier. */
	id: string;
	/** Owning user's Supabase Auth id. */
	userId: string;
	/** The absence date in YYYY-MM-DD format. */
	date: string;
	/** Classified absence kind — the highest-priority kind across all sources. */
	kind: AbsenceKind;
	/**
	 * Every reason string contributed by all data sources (ICS feeds, manual
	 * entries, holiday calendars) that apply to this user on this date.
	 * Non-empty; length ≥ 1 for any valid record.
	 */
	reasons: string[];
	/** Free-form metadata stored alongside the DB row. */
	metadata: Record<string, unknown>;
	/** ISO 8601 timestamp of record creation. */
	createdAt: string;
	/** ISO 8601 timestamp of last update. */
	updatedAt: string;
}
