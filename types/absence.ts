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
