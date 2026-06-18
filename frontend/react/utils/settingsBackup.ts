import {
	type AbsenceAssignment,
	type CalendarFeed,
	type Config,
	createDefaultConfig,
	normalizeConfig,
} from '../../stores/useConfigStore';
import type {
	CalendarMapping,
	FavoriteIssue,
	RecurringTemplate,
	ReportPreset,
} from '../../stores/useUserDataStore';

type SettingsTransferKind = 'full-backup' | 'share-pack';

export interface SettingsBackupUserData {
	favorites: FavoriteIssue[];
	templates: RecurringTemplate[];
	commentPresets: string[];
	dayNotes: Record<string, string>;
	reportPresets: ReportPreset[];
}

interface SettingsTransferBase {
	version: 2 | 3;
	kind: SettingsTransferKind;
	exportedAt: string;
	calendarMappings: CalendarMapping[];
}

export interface SettingsBackup extends SettingsTransferBase {
	version: 3;
	kind: 'full-backup';
	config: Config;
	userData?: SettingsBackupUserData;
}

export interface SettingsSharePack extends SettingsTransferBase {
	version: 2;
	kind: 'share-pack';
	config: Partial<Config>;
}

export type SettingsTransferFile = SettingsBackup | SettingsSharePack;

function normalizeCalendarFeed(
	feed: Partial<CalendarFeed>,
): CalendarFeed | null {
	const url = typeof feed.url === 'string' ? feed.url.trim() : '';
	if (!url) return null;

	return {
		label: typeof feed.label === 'string' ? feed.label.trim() : '',
		url,
		type:
			feed.type === 'absence'
				? 'absence'
				: feed.type === 'holiday'
					? 'holiday'
					: 'suggestion',
		absenceAttribution:
			feed.type === 'absence'
				? feed.absenceAttribution === 'shared'
					? 'shared'
					: feed.absenceAttribution === 'self'
						? 'self'
						: undefined
				: undefined,
		titleFilter:
			typeof feed.titleFilter === 'string'
				? feed.titleFilter.trim() || undefined
				: undefined,
	};
}

function normalizeCalendarMapping(
	mapping: Partial<CalendarMapping> & { pattern?: unknown },
): CalendarMapping | null {
	const issueKey =
		typeof mapping.issueKey === 'string'
			? mapping.issueKey.trim().toUpperCase()
			: '';
	if (!issueKey) return null;

	const collected: string[] = [];
	if (Array.isArray(mapping.patterns)) {
		for (const value of mapping.patterns) {
			if (typeof value === 'string') {
				const trimmed = value.trim();
				if (trimmed) collected.push(trimmed);
			}
		}
	}
	// Accept the legacy `{ pattern }` shape from v1 backups.
	if (typeof mapping.pattern === 'string') {
		const trimmed = mapping.pattern.trim();
		if (trimmed) collected.push(trimmed);
	}

	const seen = new Set<string>();
	const patterns: string[] = [];
	for (const value of collected) {
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		patterns.push(value);
	}
	if (patterns.length === 0) return null;

	return {
		issueKey,
		issueSummary:
			typeof mapping.issueSummary === 'string'
				? mapping.issueSummary.trim() || undefined
				: undefined,
		patterns,
	};
}

/** Merge mappings sharing an issueKey by combining their pattern lists. */
function mergeImportedMappings(mappings: CalendarMapping[]): CalendarMapping[] {
	const byIssue = new Map<string, CalendarMapping>();
	for (const mapping of mappings) {
		const existing = byIssue.get(mapping.issueKey);
		if (existing) {
			const seen = new Set(existing.patterns.map((p) => p.toLowerCase()));
			for (const pattern of mapping.patterns) {
				const key = pattern.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				existing.patterns.push(pattern);
			}
			if (!existing.issueSummary && mapping.issueSummary) {
				existing.issueSummary = mapping.issueSummary;
			}
		} else {
			byIssue.set(mapping.issueKey, { ...mapping });
		}
	}
	return [...byIssue.values()];
}

function normalizeAbsenceAssignment(
	assignment: Partial<AbsenceAssignment> & { userEmail?: string },
): AbsenceAssignment | null {
	const pattern =
		typeof assignment.pattern === 'string' ? assignment.pattern.trim() : '';
	const rawEmails: string[] = Array.isArray(assignment.userEmails)
		? (assignment.userEmails as unknown[]).filter(
				(value): value is string => typeof value === 'string',
			)
		: [];
	const legacyEmail =
		typeof assignment.userEmail === 'string' ? assignment.userEmail : '';
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

// Share packs are handed to teammates, so they must contain NO secrets or
// personal data. This is an allowlist — anything not listed here is excluded
// (apiToken/gitlabToken/rescueTimeApiKey/email are all omitted by construction).
// `calendarFeeds` and `absenceAssignments` are ALSO excluded (ADA-486):
// ICS/calendar feed URLs frequently embed a private access token (Google "secret
// address", Outlook published-calendar GUID, internal HR/absence feeds), and
// absenceAssignments carries teammates' personal emails. Recipients re-add their
// own calendars; the full backup still includes both.
function createSharePackConfig(config: Config): Partial<Config> {
	return {
		jiraHost: config.jiraHost,
		jqlFilter: config.jqlFilter,
		allowedUsers: config.allowedUsers,
		gitlabHost: config.gitlabHost,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFavoriteEntry(entry: unknown): FavoriteIssue | null {
	if (!isPlainObject(entry)) return null;
	const issueKey =
		typeof entry.issueKey === 'string'
			? entry.issueKey.trim().toUpperCase()
			: '';
	if (!issueKey) return null;
	const defaultTimeSpent =
		typeof entry.defaultTimeSpent === 'string'
			? entry.defaultTimeSpent.trim()
			: '';
	const defaultSeconds =
		typeof entry.defaultSeconds === 'number' &&
		Number.isFinite(entry.defaultSeconds)
			? entry.defaultSeconds
			: 0;
	const issueSummary =
		typeof entry.issueSummary === 'string'
			? entry.issueSummary.trim() || undefined
			: undefined;
	return { issueKey, issueSummary, defaultTimeSpent, defaultSeconds };
}

function normalizeTemplateEntry(entry: unknown): RecurringTemplate | null {
	if (!isPlainObject(entry)) return null;
	const id = typeof entry.id === 'string' ? entry.id.trim() : '';
	const issueKey =
		typeof entry.issueKey === 'string'
			? entry.issueKey.trim().toUpperCase()
			: '';
	if (!id || !issueKey) return null;
	const timeSpent =
		typeof entry.timeSpent === 'string' ? entry.timeSpent.trim() : '';
	const seconds =
		typeof entry.seconds === 'number' && Number.isFinite(entry.seconds)
			? entry.seconds
			: 0;
	const comment = typeof entry.comment === 'string' ? entry.comment : '';
	const daysOfWeek = Array.isArray(entry.daysOfWeek)
		? entry.daysOfWeek.filter(
				(day): day is number => typeof day === 'number' && day >= 0 && day <= 6,
			)
		: [];
	const enabled = entry.enabled !== false;
	const issueSummary =
		typeof entry.issueSummary === 'string'
			? entry.issueSummary.trim() || undefined
			: undefined;
	return {
		id,
		issueKey,
		issueSummary,
		timeSpent,
		seconds,
		comment,
		daysOfWeek,
		enabled,
	};
}

function normalizeReportPresetEntry(entry: unknown): ReportPreset | null {
	if (!isPlainObject(entry)) return null;
	const id = typeof entry.id === 'string' ? entry.id.trim() : '';
	const label = typeof entry.label === 'string' ? entry.label.trim() : '';
	if (!id || !label) return null;
	const viewMode = entry.viewMode === 'monthly' ? 'monthly' : 'weekly';
	const searchQuery =
		typeof entry.searchQuery === 'string' ? entry.searchQuery : '';
	const onlyAttentionNeeded = entry.onlyAttentionNeeded === true;
	const managerMode = entry.managerMode === true;
	const trendWeeks =
		typeof entry.trendWeeks === 'number' && Number.isFinite(entry.trendWeeks)
			? entry.trendWeeks
			: 4;
	const sortField =
		entry.sortField === 'total' || entry.sortField === 'gap'
			? entry.sortField
			: 'name';
	const sortDirection = entry.sortDirection === 'desc' ? 'desc' : 'asc';
	const selectedUser =
		typeof entry.selectedUser === 'string' ? entry.selectedUser : '';
	return {
		id,
		label,
		viewMode,
		searchQuery,
		onlyAttentionNeeded,
		managerMode,
		trendWeeks,
		sortField,
		sortDirection,
		selectedUser,
	};
}

function normalizeUserData(value: unknown): SettingsBackupUserData | undefined {
	if (!isPlainObject(value)) return undefined;
	const favorites = Array.isArray(value.favorites)
		? value.favorites
				.map(normalizeFavoriteEntry)
				.filter((entry): entry is FavoriteIssue => entry !== null)
		: [];
	const templates = Array.isArray(value.templates)
		? value.templates
				.map(normalizeTemplateEntry)
				.filter((entry): entry is RecurringTemplate => entry !== null)
		: [];
	const commentPresets = Array.isArray(value.commentPresets)
		? value.commentPresets
				.filter((item): item is string => typeof item === 'string')
				.map((item) => item.trim())
				.filter((item) => item.length > 0)
		: [];
	const dayNotes: Record<string, string> = {};
	if (isPlainObject(value.dayNotes)) {
		for (const [key, note] of Object.entries(value.dayNotes)) {
			if (typeof key === 'string' && key.trim() && typeof note === 'string') {
				dayNotes[key] = note;
			}
		}
	}
	const reportPresets = Array.isArray(value.reportPresets)
		? value.reportPresets
				.map(normalizeReportPresetEntry)
				.filter((entry): entry is ReportPreset => entry !== null)
		: [];
	return { favorites, templates, commentPresets, dayNotes, reportPresets };
}

export function createSettingsBackup(
	config: Config,
	calendarMappings: CalendarMapping[],
	userData?: SettingsBackupUserData,
): SettingsBackup {
	const backup: SettingsBackup = {
		version: 3,
		kind: 'full-backup',
		exportedAt: new Date().toISOString(),
		config,
		calendarMappings,
	};
	if (userData) {
		backup.userData = {
			favorites: userData.favorites ?? [],
			templates: userData.templates ?? [],
			commentPresets: userData.commentPresets ?? [],
			dayNotes: userData.dayNotes ?? {},
			reportPresets: userData.reportPresets ?? [],
		};
	}
	return backup;
}

export function createSettingsSharePack(
	config: Config,
	calendarMappings: CalendarMapping[],
): SettingsSharePack {
	return {
		version: 2,
		kind: 'share-pack',
		exportedAt: new Date().toISOString(),
		config: createSharePackConfig(config),
		calendarMappings,
	};
}

export function parseSettingsBackup(
	raw: string,
	defaultConfig: Config,
): {
	config: Config;
	calendarMappings: CalendarMapping[];
	userData?: SettingsBackupUserData;
	kind: SettingsTransferKind;
} {
	let parsed: unknown;

	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('Invalid JSON file');
	}

	if (!parsed || typeof parsed !== 'object') {
		throw new Error('Settings backup must be a JSON object');
	}

	const data = parsed as Partial<SettingsTransferFile> & {
		config?: Partial<Config>;
		calendarMappings?: Partial<CalendarMapping>[];
		userData?: unknown;
		version?: 1 | 2 | 3;
	};

	if (!data.config || typeof data.config !== 'object') {
		throw new Error('Settings backup is missing a valid config object');
	}

	const kind: SettingsTransferKind =
		data.kind === 'share-pack' ? 'share-pack' : 'full-backup';
	const fallbackConfig =
		kind === 'share-pack' ? defaultConfig : createDefaultConfig();

	const config = normalizeConfig(
		{
			...data.config,
			calendarFeeds: Array.isArray(data.config.calendarFeeds)
				? data.config.calendarFeeds
						.map(normalizeCalendarFeed)
						.filter((feed): feed is CalendarFeed => feed !== null)
				: fallbackConfig.calendarFeeds,
			absenceAssignments: Array.isArray(data.config.absenceAssignments)
				? data.config.absenceAssignments
						.map(normalizeAbsenceAssignment)
						.filter(
							(assignment): assignment is AbsenceAssignment =>
								assignment !== null,
						)
				: fallbackConfig.absenceAssignments,
		},
		fallbackConfig,
	);

	const calendarMappings = Array.isArray(data.calendarMappings)
		? mergeImportedMappings(
				data.calendarMappings
					.map(normalizeCalendarMapping)
					.filter((mapping): mapping is CalendarMapping => mapping !== null),
			)
		: [];

	const userData =
		kind === 'full-backup' ? normalizeUserData(data.userData) : undefined;

	return { config, calendarMappings, userData, kind };
}
