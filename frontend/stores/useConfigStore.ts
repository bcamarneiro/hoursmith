import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { migrateStorageKey } from './migrateStorageKeys';
import { getPersistStorage } from './persistStorage';

export interface CalendarFeed {
	label: string;
	url: string;
	/**
	 * - `suggestion`: feed surfaces upcoming events to seed worklog suggestions.
	 * - `absence`: per-user time off (vacation / sick / off). Requires
	 *   `absenceAttribution` to pick between self-only filtering or shared
	 *   attribution via title patterns.
	 * - `holiday`: public holidays — applies to every team member with no
	 *   attribution needed.
	 */
	type: 'suggestion' | 'absence' | 'holiday';
	absenceAttribution?: 'self' | 'shared';
	titleFilter?: string;
}

export interface AbsenceAssignment {
	pattern: string;
	/**
	 * Emails of teammates this pattern applies to. The same pattern routes a
	 * single calendar event to one (most absences) or many (regional holidays)
	 * users. Empty arrays are normalised out.
	 */
	userEmails: string[];
}

export interface Config {
	jiraHost: string;
	email: string;
	apiToken: string;
	corsProxy: string;
	jqlFilter: string;
	allowedUsers: string;
	canAddWorklogs: boolean;
	canEditWorklogs: boolean;
	canDeleteWorklogs: boolean;
	gitlabToken: string;
	gitlabHost: string;
	rescueTimeApiKey: string;
	calendarFeeds: CalendarFeed[];
	absenceAssignments: AbsenceAssignment[];
	complianceReminderEnabled: boolean;
	theme: 'system' | 'light' | 'dark';
	timeRounding: 'off' | '15m' | '30m';
	/**
	 * When true (default), CSV exports include `IsAbsence` / `AbsenceKind`
	 * columns and an `AbsenceDays` subtotal so finance/HR consumers can
	 * reconcile reduced targets against external records. Off by default
	 * for new installs would silently strip data — keep on.
	 */
	includeAbsenceInCsv: boolean;
	/**
	 * When true, CSV exports append a `# generated=… jira=… policy=… period=…`
	 * provenance footer line (traceability for finance/audit). Off by default
	 * so exports are clean and don't leak the Jira host / build version.
	 */
	includeCsvProvenance: boolean;
}

interface ConfigState {
	config: Config;
	setConfig: (newConfig: Config) => void;
}

export const CONFIG_STORAGE_VERSION = 6;

function normalizeHost(value: unknown): string {
	if (typeof value !== 'string') return '';

	return value
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/+$/g, '');
}

function normalizeProxyUrl(value: unknown): string {
	if (typeof value !== 'string') return '';
	return value.trim().replace(/\/+$/g, '');
}

function normalizeCsvList(value: unknown): string {
	if (typeof value !== 'string') return '';

	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.join(', ');
}

function normalizeCalendarFeed(
	feed: Partial<CalendarFeed> | undefined,
): CalendarFeed | null {
	const url =
		typeof feed?.url === 'string' ? feed.url.trim().replace(/\/+$/g, '') : '';
	if (!url) return null;
	const type: CalendarFeed['type'] =
		feed?.type === 'absence'
			? 'absence'
			: feed?.type === 'holiday'
				? 'holiday'
				: 'suggestion';

	return {
		label: typeof feed?.label === 'string' ? feed.label.trim() : '',
		url,
		type,
		// Attribution applies only to absence feeds; holiday feeds apply to
		// every user and skip the attribution path entirely.
		absenceAttribution:
			type === 'absence'
				? feed?.absenceAttribution === 'shared'
					? 'shared'
					: feed?.absenceAttribution === 'self'
						? 'self'
						: undefined
				: undefined,
		titleFilter:
			typeof feed?.titleFilter === 'string'
				? feed.titleFilter.trim() || undefined
				: undefined,
	};
}

function normalizeAbsenceAssignment(
	assignment: (Partial<AbsenceAssignment> & { userEmail?: string }) | undefined,
): AbsenceAssignment | null {
	const pattern =
		typeof assignment?.pattern === 'string' ? assignment.pattern.trim() : '';
	const rawEmails: string[] = Array.isArray(assignment?.userEmails)
		? (assignment.userEmails as unknown[]).filter(
				(value): value is string => typeof value === 'string',
			)
		: [];
	// Migrate the v5 single-email shape `{ pattern, userEmail }` to the v6
	// list shape transparently.
	const legacyEmail =
		typeof assignment?.userEmail === 'string' ? assignment.userEmail : '';
	const merged = legacyEmail ? [...rawEmails, legacyEmail] : rawEmails;
	const userEmails = Array.from(
		new Set(
			merged
				.map((email) => email.trim().toLowerCase())
				.filter((email) => email.length > 0),
		),
	);
	if (!pattern || userEmails.length === 0) return null;

	return {
		pattern,
		userEmails,
	};
}

export function createDefaultConfig(): Config {
	return {
		jiraHost: '',
		email: '',
		apiToken: '',
		corsProxy: '',
		jqlFilter: '',
		allowedUsers: '',
		canAddWorklogs: true,
		canEditWorklogs: true,
		canDeleteWorklogs: true,
		gitlabToken: '',
		gitlabHost: '',
		rescueTimeApiKey: '',
		calendarFeeds: [],
		absenceAssignments: [],
		complianceReminderEnabled: false,
		theme: 'system',
		timeRounding: 'off',
		includeAbsenceInCsv: true,
		includeCsvProvenance: false,
	};
}

export function normalizeConfig(
	config: Partial<Config> | undefined,
	fallback: Config = createDefaultConfig(),
): Config {
	const normalizedAbsenceAssignments = Array.isArray(config?.absenceAssignments)
		? config.absenceAssignments
				.map(normalizeAbsenceAssignment)
				.filter(
					(assignment): assignment is AbsenceAssignment => assignment !== null,
				)
		: fallback.absenceAssignments.map((assignment) => ({ ...assignment }));
	const normalizedCalendarFeeds = Array.isArray(config?.calendarFeeds)
		? config.calendarFeeds
				.map(normalizeCalendarFeed)
				.filter((feed): feed is CalendarFeed => feed !== null)
				.map((feed) =>
					feed.type === 'absence'
						? {
								...feed,
								absenceAttribution:
									feed.absenceAttribution ??
									(feed.titleFilter?.trim() ||
									normalizedAbsenceAssignments.length === 0
										? 'self'
										: 'shared'),
							}
						: feed,
				)
		: fallback.calendarFeeds.map((feed) => ({ ...feed }));

	return {
		...fallback,
		...config,
		jiraHost: normalizeHost(config?.jiraHost ?? fallback.jiraHost),
		email:
			typeof config?.email === 'string'
				? config.email.trim()
				: fallback.email.trim(),
		apiToken:
			typeof config?.apiToken === 'string'
				? config.apiToken.trim()
				: fallback.apiToken.trim(),
		corsProxy: normalizeProxyUrl(config?.corsProxy ?? fallback.corsProxy),
		jqlFilter:
			typeof config?.jqlFilter === 'string'
				? config.jqlFilter.trim()
				: fallback.jqlFilter,
		allowedUsers: normalizeCsvList(
			config?.allowedUsers ?? fallback.allowedUsers,
		),
		canAddWorklogs:
			typeof config?.canAddWorklogs === 'boolean'
				? config.canAddWorklogs
				: fallback.canAddWorklogs,
		canEditWorklogs:
			typeof config?.canEditWorklogs === 'boolean'
				? config.canEditWorklogs
				: fallback.canEditWorklogs,
		canDeleteWorklogs:
			typeof config?.canDeleteWorklogs === 'boolean'
				? config.canDeleteWorklogs
				: fallback.canDeleteWorklogs,
		gitlabToken:
			typeof config?.gitlabToken === 'string'
				? config.gitlabToken.trim()
				: fallback.gitlabToken.trim(),
		gitlabHost: normalizeHost(config?.gitlabHost ?? fallback.gitlabHost),
		rescueTimeApiKey:
			typeof config?.rescueTimeApiKey === 'string'
				? config.rescueTimeApiKey.trim()
				: fallback.rescueTimeApiKey.trim(),
		calendarFeeds: normalizedCalendarFeeds,
		absenceAssignments: normalizedAbsenceAssignments,
		complianceReminderEnabled:
			typeof config?.complianceReminderEnabled === 'boolean'
				? config.complianceReminderEnabled
				: fallback.complianceReminderEnabled,
		theme:
			config?.theme === 'light' ||
			config?.theme === 'dark' ||
			config?.theme === 'system'
				? config.theme
				: fallback.theme,
		timeRounding:
			config?.timeRounding === '15m' ||
			config?.timeRounding === '30m' ||
			config?.timeRounding === 'off'
				? config.timeRounding
				: fallback.timeRounding,
		includeAbsenceInCsv:
			typeof config?.includeAbsenceInCsv === 'boolean'
				? config.includeAbsenceInCsv
				: fallback.includeAbsenceInCsv,
		includeCsvProvenance:
			typeof config?.includeCsvProvenance === 'boolean'
				? config.includeCsvProvenance
				: fallback.includeCsvProvenance,
	};
}

/**
 * Notable schema changes:
 *   v1 → initial shape (no calendarFeeds, no absenceAssignments)
 *   v2 → added gitlabHost, calendarFeeds[]
 *   v3 → added absenceAssignments[], complianceReminderEnabled
 *   v4 → added timeRounding tri-state, theme widening
 *   v5 → added 'holiday' as a CalendarFeed.type (no shape change; existing
 *        'absence' feeds remain valid)
 *   v6 → AbsenceAssignment.userEmail (string) → userEmails (string[]). The
 *        legacy shape is handled by `normalizeAbsenceAssignment` so the
 *        migrate step is a no-op pass-through normaliser.
 * Each "v0_to_vN" helper is a defensive normaliser that accepts whatever
 * legacy shape was on disk and produces a valid current Config. Today,
 * all branches collapse to `normalizeConfig` because every persisted
 * field is either nullable or has a sane fallback in normalizeConfig.
 * Keep the explicit branching so future schema changes can be added
 * without re-introducing the no-op pattern.
 */
function migrateLegacy_v0_to_v6(
	legacyConfig: Partial<Config> | undefined,
): Config {
	return normalizeConfig(legacyConfig);
}

export function migratePersistedConfigState(
	persisted: unknown,
	version: number,
): Partial<ConfigState> {
	const persistedState = persisted as Partial<ConfigState> | undefined;
	const legacyConfig = persistedState?.config;

	if (version < CONFIG_STORAGE_VERSION) {
		return { config: migrateLegacy_v0_to_v6(legacyConfig) };
	}

	// Same-version path: still normalise to absorb hand-edited blobs and
	// runtime-typed garbage (see useUserDataStore for the broader guards).
	return { config: normalizeConfig(legacyConfig) };
}

// Carry existing users' data across the jira-timesheet-report → hoursmith rename.
migrateStorageKey('jira-timesheet-config', 'hoursmith-config');

export const useConfigStore = create<ConfigState>()(
	persist(
		(set) => ({
			config: createDefaultConfig(),
			setConfig: (newConfig) => set({ config: normalizeConfig(newConfig) }),
		}),
		{
			name: 'hoursmith-config',
			storage: createJSONStorage(getPersistStorage),
			version: CONFIG_STORAGE_VERSION,
			migrate: (persistedState, version) =>
				migratePersistedConfigState(persistedState, version),
			merge: (persisted, current) => {
				const persistedState = persisted as Partial<ConfigState> | undefined;
				return {
					...current,
					config: normalizeConfig(
						persistedState?.config,
						(current as ConfigState).config,
					),
				};
			},
		},
	),
);
