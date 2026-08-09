/**
 * absences.ts — Canonical absence schema types.
 *
 * Foundation for the user_absences DB table and the cron-based absence
 * ingestion pipeline. Defined here (frontend) as the single shared source
 * of truth for client-side code; the server-side | premium | equivalent
 * lives in premium/api/_lib/supabaseAdmin.ts.
 *
 * NOTE: This file was created by ADA-644 / dev-swarm because the parent
 * task (ADA-643) did not produce it. When ADA-643 lands, reconcile the
 * types here with any additions the parent branch makes.
 *
 * @module
 */

import type { AbsenceKind } from '../../types/absence';

/**
 * Canonical absence record shape for upsert into the user_absences table.
 *
 * | Column        | Type      | Notes                                          |
 * |---------------|-----------|-------------------------------------------------|
 * | user_id       | uuid/text | opaque user identifier (email in client-side)   |
 * | provider_id   | uuid/text | FK into absence_providers; null for manual rows  |
 * | absence_date  | date      | YYYY-MM-DD                                      |
 * | kind          | text      | vacation / sick / off / holiday                  |
 * | reason        | text      | human-readable label                            |
 * | metadata      | jsonb     | optional source-specific payload                |
 *
 * The unique constraint is (user_id, absence_date, provider_id) where
 * provider_id IS NOT NULL — manual entries with null provider_id have a
 * separate constraint.
 */
export interface UserAbsenceUpsert {
	user_id: string;
	provider_id: string | null;
	absence_date: string;
	kind: AbsenceKind;
	reason: string;
	metadata?: Record<string, unknown>;
}

/** Alias for use in contexts where the upsert will be INSERTed. */
export type UserAbsenceInput = Omit<UserAbsenceUpsert, 'provider_id'> & {
	provider_id: string | null;
};

/**
 * Client-side absence day aggregation (kept here for shared reference).
 * The canonical source of truth for client rendering is still
 * AbsenceDay / UserAbsenceDays exported from absenceService.ts.
 */
export interface AbsenceDay {
	date: string;
	reasons: string[];
	kind: AbsenceKind;
}

/** Per-user map: email → date → AbsenceDay. */
export type UserAbsenceDays = Map<string, Map<string, AbsenceDay>>;
