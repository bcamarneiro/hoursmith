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
	githubToken: string;
	githubHost: string;
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
	/**
	 * When true, anonymous product analytics are suppressed. Default false
	 * (analytics on, so a missing/undefined value behaves as opted-in). Read by
	 * `analytics.ts` to gate capture; this store only owns the field + its
	 * normalisation. Optional so existing full-`Config` fixtures/literals keep
	 * compiling — `createDefaultConfig`/`normalizeConfig` always populate it.
	 */
	analyticsOptOut?: boolean;
	/**
	 * Team completeness: expected working hours **per weekday**, used as each
	 * member's daily target (ADA-392 / ADA-386). `expectedDailyHours` is the
	 * team-wide default (8 when unset); `expectedHoursByUser` maps a lowercased
	 * email to a per-person daily override so contractors / part-timers aren't
	 * perpetually flagged red. Per-day *schedules* (which weekdays are working
	 * days) are deliberately deferred — see ADA-386. Optional so existing full-
	 * `Config` fixtures keep compiling; `createDefaultConfig` / `normalizeConfig`
	 * always populate them.
	 */
	expectedDailyHours?: number;
	expectedHoursByUser?: Record<string, number>;
	/**
	 * Weekly timesheet deadline (ADA-387): the weekday (1=Mon … 7=Sun) and local
	 * `HH:MM` time by which the week should be logged. Used to classify each
	 * member as on-time / late / incomplete. Defaults to Friday 18:00. Optional so
	 * existing fixtures compile; `createDefaultConfig` / `normalizeConfig` populate
	 * them.
	 */
	weeklyDeadlineWeekday?: number;
	weeklyDeadlineTime?: string;
}

interface ConfigState {
	config: Config;
	setConfig: (newConfig: Config) => void;
}

export const CONFIG_STORAGE_VERSION = 10;

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
		githubToken: '',
		githubHost: '',
		rescueTimeApiKey: '',
		calendarFeeds: [],
		absenceAssignments: [],
		complianceReminderEnabled: false,
		theme: 'system',
		timeRounding: 'off',
		includeAbsenceInCsv: true,
		includeCsvProvenance: false,
		analyticsOptOut: false,
		expectedDailyHours: 8,
		expectedHoursByUser: {},
		weeklyDeadlineWeekday: 5,
		weeklyDeadlineTime: '18:00',
	};
}

/** Clamp the weekly-deadline weekday to 1 (Mon) … 7 (Sun); fall back otherwise. */
function normalizeDeadlineWeekday(value: unknown, fallback: number): number {
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > 7
	) {
		return fallback;
	}
	return value;
}

/** Validate an `HH:MM` 24h time string; fall back on anything malformed. */
function normalizeDeadlineTime(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback;
	const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return fallback;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
	return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

/** Clamp a per-day expected-hours value to a sane range (0 < h ≤ 24). A
 *  non-number, or 0/negative (which would flag no one, almost always a
 *  mistake), falls back to the provided default. */
function normalizeDailyHours(value: unknown, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.min(value, 24);
}

/** Normalise the per-user override map: lowercase/trim the email keys and drop
 *  any entry whose value isn't a sane per-day figure (0 < h ≤ 24). */
function normalizeExpectedHoursByUser(value: unknown): Record<string, number> {
	if (!value || typeof value !== 'object') return {};
	const result: Record<string, number> = {};
	for (const [rawEmail, rawHours] of Object.entries(
		value as Record<string, unknown>,
	)) {
		const email = rawEmail.trim().toLowerCase();
		if (!email) continue;
		if (
			typeof rawHours !== 'number' ||
			!Number.isFinite(rawHours) ||
			rawHours <= 0 ||
			rawHours > 24
		) {
			continue;
		}
		result[email] = rawHours;
	}
	return result;
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
		githubToken:
			typeof config?.githubToken === 'string'
				? config.githubToken.trim()
				: fallback.githubToken.trim(),
		githubHost: normalizeHost(config?.githubHost ?? fallback.githubHost),
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
		analyticsOptOut:
			typeof config?.analyticsOptOut === 'boolean'
				? config.analyticsOptOut
				: fallback.analyticsOptOut,
		expectedDailyHours: normalizeDailyHours(
			config?.expectedDailyHours,
			fallback.expectedDailyHours ?? 8,
		),
		expectedHoursByUser:
			config?.expectedHoursByUser !== undefined
				? normalizeExpectedHoursByUser(config.expectedHoursByUser)
				: { ...(fallback.expectedHoursByUser ?? {}) },
		weeklyDeadlineWeekday: normalizeDeadlineWeekday(
			config?.weeklyDeadlineWeekday,
			fallback.weeklyDeadlineWeekday ?? 5,
		),
		weeklyDeadlineTime: normalizeDeadlineTime(
			config?.weeklyDeadlineTime,
			fallback.weeklyDeadlineTime ?? '18:00',
		),
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
 *   v7 → added analyticsOptOut (boolean, default false). No shape change;
 *        `normalizeConfig` fills the field for pre-v7 blobs.
 *   v8 → added githubToken/githubHost (strings, default ''). No shape change;
 *        `normalizeConfig` fills the fields for pre-v8 blobs.
 *   v9 → added expectedDailyHours (number, default 8) + expectedHoursByUser
 *        (Record<email, hours>, default {}). No shape change; `normalizeConfig`
 *        fills them for pre-v9 blobs (existing installs keep the 8h behaviour).
 *   v10 → added weeklyDeadlineWeekday (1–7, default 5=Fri) + weeklyDeadlineTime
 *        ("HH:MM", default "18:00"). No shape change; `normalizeConfig` fills
 *        them for pre-v10 blobs.
 * Each "v0_to_vN" helper is a defensive normaliser that accepts whatever
 * legacy shape was on disk and produces a valid current Config. Today,
 * all branches collapse to `normalizeConfig` because every persisted
 * field is either nullable or has a sane fallback in normalizeConfig.
 * Keep the explicit branching so future schema changes can be added
 * without re-introducing the no-op pattern.
 */
function migrateLegacy_v0_to_v10(
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
		return { config: migrateLegacy_v0_to_v10(legacyConfig) };
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
