import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { migrateStorageKey } from './migrateStorageKeys';
import { getPersistStorage } from './persistStorage';

/**
 * Bumped when the persisted shape changes in a way that requires
 * migration.
 *   v1 → initial explicit version (prior blobs had no version field).
 *   v2 → CalendarMapping shape flipped from { pattern, issueKey } to
 *        { issueKey, patterns[] }. Legacy single-pattern entries are
 *        grouped by issueKey during migration via `normalizeCalendarMapping`
 *        + the dedupe/merge step in `mergeCalendarMappings`.
 */
export const USER_DATA_STORAGE_VERSION = 2;

function safeArray<T>(value: unknown, fallback: T[]): T[] {
	return Array.isArray(value) ? (value as T[]) : fallback;
}

function safeStringRecord(
	value: unknown,
	fallback: Record<string, string>,
): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return fallback;
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof k === 'string' && typeof v === 'string') {
			out[k] = v;
		}
	}
	return out;
}

export interface FavoriteIssue {
	issueKey: string;
	issueSummary?: string;
	defaultTimeSpent: string; // e.g., "1h"
	defaultSeconds: number;
}

export interface CalendarMapping {
	issueKey: string;
	issueSummary?: string;
	/**
	 * Event title patterns (case-insensitive substring) that should resolve
	 * to this issue. Many event names commonly share a single ticket, so
	 * the mapping is keyed by `issueKey` rather than by pattern.
	 */
	patterns: string[];
}

export interface RecurringTemplate {
	id: string;
	issueKey: string;
	issueSummary?: string;
	timeSpent: string;
	seconds: number;
	comment: string;
	daysOfWeek: number[]; // 0=Sun, 1=Mon, ... 6=Sat
	enabled: boolean;
}

export interface ReportPreset {
	id: string;
	label: string;
	viewMode: 'weekly' | 'monthly';
	searchQuery: string;
	onlyAttentionNeeded: boolean;
	managerMode: boolean;
	trendWeeks: number;
	sortField: 'name' | 'total' | 'gap';
	sortDirection: 'asc' | 'desc';
	selectedUser: string;
}

interface UserDataState {
	favorites: FavoriteIssue[];
	templates: RecurringTemplate[];
	commentPresets: string[];
	dayNotes: Record<string, string>;
	calendarMappings: CalendarMapping[];
	reportPresets: ReportPreset[];
	addFavorite: (issue: FavoriteIssue) => void;
	removeFavorite: (issueKey: string) => void;
	addTemplate: (template: RecurringTemplate) => void;
	removeTemplate: (id: string) => void;
	toggleTemplate: (id: string) => void;
	addCommentPreset: (preset: string) => void;
	removeCommentPreset: (preset: string) => void;
	setDayNote: (date: string, note: string) => void;
	addCalendarMapping: (mapping: CalendarMapping) => void;
	removeCalendarMapping: (issueKey: string) => void;
	updateCalendarMapping: (issueKey: string, updated: CalendarMapping) => void;
	replaceCalendarMappings: (mappings: CalendarMapping[]) => void;
	/**
	 * Convenience for "map this event title to an issue". If a mapping
	 * already exists for the issue, the pattern is appended; otherwise a
	 * new mapping is created.
	 */
	addPatternToMapping: (
		issueKey: string,
		pattern: string,
		issueSummary?: string,
	) => void;
	saveReportPreset: (preset: ReportPreset) => void;
	removeReportPreset: (id: string) => void;
}

function normalizeIssueKey(issueKey: unknown): string {
	return typeof issueKey === 'string' ? issueKey.trim().toUpperCase() : '';
}

function normalizePattern(pattern: unknown): string {
	return typeof pattern === 'string' ? pattern.trim() : '';
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function normalizeFavorite(issue: FavoriteIssue): FavoriteIssue {
	const raw = issue as Partial<FavoriteIssue>;
	const seconds =
		typeof raw.defaultSeconds === 'number' &&
		Number.isFinite(raw.defaultSeconds)
			? raw.defaultSeconds
			: 0;
	const summary =
		typeof raw.issueSummary === 'string' ? raw.issueSummary.trim() : '';
	return {
		issueKey: normalizeIssueKey(raw.issueKey),
		defaultTimeSpent: asString(raw.defaultTimeSpent).trim(),
		defaultSeconds: seconds,
		issueSummary: summary || undefined,
	};
}

function normalizeTemplate(template: RecurringTemplate): RecurringTemplate {
	const raw = template as Partial<RecurringTemplate>;
	const days = Array.isArray(raw.daysOfWeek)
		? raw.daysOfWeek.filter(
				(d): d is number => typeof d === 'number' && d >= 0 && d <= 6,
			)
		: [];
	return {
		id: asString(raw.id),
		issueKey: normalizeIssueKey(raw.issueKey),
		issueSummary:
			typeof raw.issueSummary === 'string'
				? raw.issueSummary.trim() || undefined
				: undefined,
		timeSpent: asString(raw.timeSpent).trim(),
		seconds:
			typeof raw.seconds === 'number' && Number.isFinite(raw.seconds)
				? raw.seconds
				: 0,
		comment: asString(raw.comment).trim(),
		daysOfWeek: [...new Set(days)].sort((a, b) => a - b),
		enabled: raw.enabled !== false,
	};
}

function normalizeCalendarMapping(mapping: CalendarMapping): CalendarMapping {
	// Accept both the current shape and the legacy v1 shape
	// `{ pattern, issueKey, issueSummary }` from persisted blobs.
	const raw = mapping as Partial<CalendarMapping> & { pattern?: unknown };
	const summary =
		typeof raw.issueSummary === 'string' ? raw.issueSummary.trim() : '';
	const legacyPattern =
		typeof raw.pattern === 'string' ? normalizePattern(raw.pattern) : '';
	const collected: string[] = Array.isArray(raw.patterns)
		? raw.patterns
				.filter((p): p is string => typeof p === 'string')
				.map((p) => normalizePattern(p))
		: [];
	if (legacyPattern) collected.push(legacyPattern);
	const patterns = dedupePreserveOrder(collected.filter(Boolean));
	return {
		issueKey: normalizeIssueKey(raw.issueKey),
		issueSummary: summary || undefined,
		patterns,
	};
}

function dedupePreserveOrder(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const key = value.toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(value);
	}
	return out;
}

/**
 * Merge mappings with the same `issueKey` (combining their pattern lists).
 * This is the load-bearing step that turns the v1 "one row per pattern"
 * shape into the v2 "one row per issue" shape during migration, and is
 * also used to dedupe the import path.
 */
function mergeCalendarMappings(mappings: CalendarMapping[]): CalendarMapping[] {
	const byIssue = new Map<string, CalendarMapping>();
	for (const mapping of mappings) {
		if (!mapping.issueKey) continue;
		const existing = byIssue.get(mapping.issueKey);
		if (existing) {
			existing.patterns = dedupePreserveOrder([
				...existing.patterns,
				...mapping.patterns,
			]);
			if (!existing.issueSummary && mapping.issueSummary) {
				existing.issueSummary = mapping.issueSummary;
			}
		} else {
			byIssue.set(mapping.issueKey, { ...mapping });
		}
	}
	return [...byIssue.values()].filter((m) => m.patterns.length > 0);
}

function normalizeReportPreset(preset: ReportPreset): ReportPreset {
	const raw = preset as Partial<ReportPreset>;
	const trendWeeks =
		typeof raw.trendWeeks === 'number' && [4, 6, 8, 12].includes(raw.trendWeeks)
			? raw.trendWeeks
			: 6;
	return {
		id: asString(raw.id).trim(),
		label: asString(raw.label).trim(),
		viewMode: raw.viewMode === 'monthly' ? 'monthly' : 'weekly',
		searchQuery: asString(raw.searchQuery).trim(),
		onlyAttentionNeeded: raw.onlyAttentionNeeded === true,
		managerMode: raw.managerMode === true,
		trendWeeks,
		sortField:
			raw.sortField === 'total' || raw.sortField === 'gap'
				? raw.sortField
				: 'name',
		sortDirection: raw.sortDirection === 'desc' ? 'desc' : 'asc',
		selectedUser: asString(raw.selectedUser).trim(),
	};
}

function dedupeByCaseInsensitive<T>(
	items: T[],
	getKey: (item: T) => string,
): T[] {
	const seen = new Set<string>();
	const result: T[] = [];

	for (const item of items) {
		const key = getKey(item).trim().toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(item);
	}

	return result;
}

// Carry existing users' data across the jira-timesheet-report → hoursmith rename.
migrateStorageKey('jira-timesheet-userdata', 'hoursmith-userdata');

export const useUserDataStore = create<UserDataState>()(
	persist(
		(set) => ({
			favorites: [],
			templates: [],
			commentPresets: [],
			dayNotes: {},
			calendarMappings: [],
			reportPresets: [],

			addFavorite: (issue) =>
				set((state) => {
					const normalized = normalizeFavorite(issue);
					if (
						!normalized.issueKey ||
						state.favorites.some((f) => f.issueKey === normalized.issueKey)
					) {
						return state;
					}
					return { favorites: [...state.favorites, normalized] };
				}),

			removeFavorite: (issueKey) =>
				set((state) => ({
					favorites: state.favorites.filter(
						(f) => f.issueKey !== normalizeIssueKey(issueKey),
					),
				})),

			addTemplate: (template) =>
				set((state) => {
					const normalized = normalizeTemplate(template);
					const duplicate = state.templates.some(
						(existing) =>
							existing.issueKey === normalized.issueKey &&
							existing.timeSpent === normalized.timeSpent &&
							existing.comment === normalized.comment &&
							existing.enabled === normalized.enabled &&
							existing.daysOfWeek.join(',') === normalized.daysOfWeek.join(','),
					);
					if (!normalized.issueKey || duplicate) {
						return state;
					}
					return {
						templates: [...state.templates, normalized],
					};
				}),

			removeTemplate: (id) =>
				set((state) => ({
					templates: state.templates.filter((t) => t.id !== id),
				})),

			toggleTemplate: (id) =>
				set((state) => ({
					templates: state.templates.map((t) =>
						t.id === id ? { ...t, enabled: !t.enabled } : t,
					),
				})),

			addCommentPreset: (preset) =>
				set((state) => {
					const trimmed = preset.trim();
					if (
						!trimmed ||
						state.commentPresets.some(
							(existing) => existing.toLowerCase() === trimmed.toLowerCase(),
						)
					) {
						return state;
					}
					return { commentPresets: [...state.commentPresets, trimmed] };
				}),

			removeCommentPreset: (preset) =>
				set((state) => ({
					commentPresets: state.commentPresets.filter((p) => p !== preset),
				})),

			setDayNote: (date, note) =>
				set((state) => {
					const trimmed = note.trim();
					const updated = { ...state.dayNotes };
					if (trimmed) {
						updated[date] = trimmed;
					} else {
						delete updated[date];
					}
					return { dayNotes: updated };
				}),

			addCalendarMapping: (mapping) =>
				set((state) => {
					const normalized = normalizeCalendarMapping(mapping);
					if (
						!normalized.issueKey ||
						normalized.patterns.length === 0 ||
						state.calendarMappings.some(
							(m) => m.issueKey === normalized.issueKey,
						)
					) {
						return state;
					}
					return {
						calendarMappings: [...state.calendarMappings, normalized],
					};
				}),

			removeCalendarMapping: (issueKey) =>
				set((state) => {
					const key = issueKey.trim().toUpperCase();
					return {
						calendarMappings: state.calendarMappings.filter(
							(m) => m.issueKey !== key,
						),
					};
				}),

			updateCalendarMapping: (issueKey, updated) =>
				set((state) => {
					const targetKey = issueKey.trim().toUpperCase();
					const normalized = normalizeCalendarMapping(updated);
					if (!normalized.issueKey || normalized.patterns.length === 0) {
						return state;
					}
					const isDuplicate = state.calendarMappings.some(
						(m) =>
							m.issueKey === normalized.issueKey && m.issueKey !== targetKey,
					);
					if (isDuplicate) {
						return state;
					}
					return {
						calendarMappings: state.calendarMappings.map((m) =>
							m.issueKey === targetKey ? normalized : m,
						),
					};
				}),

			replaceCalendarMappings: (mappings) =>
				set({
					calendarMappings: mergeCalendarMappings(
						mappings
							.map(normalizeCalendarMapping)
							.filter(
								(mapping) => !!mapping.issueKey && mapping.patterns.length > 0,
							),
					),
				}),

			addPatternToMapping: (issueKey, pattern, issueSummary) =>
				set((state) => {
					const key = normalizeIssueKey(issueKey);
					const trimmed = normalizePattern(pattern);
					if (!key || !trimmed) return state;
					const existing = state.calendarMappings.find(
						(m) => m.issueKey === key,
					);
					if (existing) {
						const nextPatterns = dedupePreserveOrder([
							...existing.patterns,
							trimmed,
						]);
						if (nextPatterns.length === existing.patterns.length) {
							return state;
						}
						return {
							calendarMappings: state.calendarMappings.map((m) =>
								m.issueKey === key
									? {
											...m,
											patterns: nextPatterns,
											issueSummary: m.issueSummary || issueSummary?.trim(),
										}
									: m,
							),
						};
					}
					return {
						calendarMappings: [
							...state.calendarMappings,
							{
								issueKey: key,
								issueSummary: issueSummary?.trim() || undefined,
								patterns: [trimmed],
							},
						],
					};
				}),

			saveReportPreset: (preset) =>
				set((state) => {
					const normalized = normalizeReportPreset(preset);
					if (!normalized.id || !normalized.label) {
						return state;
					}

					const existingIndex = state.reportPresets.findIndex(
						(item) => item.id === normalized.id,
					);
					if (existingIndex === -1) {
						return {
							reportPresets: [...state.reportPresets, normalized],
						};
					}

					return {
						reportPresets: state.reportPresets.map((item) =>
							item.id === normalized.id ? normalized : item,
						),
					};
				}),

			removeReportPreset: (id) =>
				set((state) => ({
					reportPresets: state.reportPresets.filter(
						(preset) => preset.id !== id,
					),
				})),
		}),
		{
			name: 'hoursmith-userdata',
			storage: createJSONStorage(getPersistStorage),
			version: USER_DATA_STORAGE_VERSION,
			migrate: (persistedState, _version) => {
				// All migrations collapse to the merge function's defensive
				// path today: drop malformed entries silently and re-shape
				// arrays/records via safe* guards. Branching is explicit so
				// future schema changes can intercept here without changing
				// the caller contract.
				return persistedState;
			},
			merge: (persisted, current) => {
				const persistedState = persisted as Partial<UserDataState> | undefined;
				const currentState = current as UserDataState;
				return {
					...currentState,
					favorites: dedupeByCaseInsensitive(
						safeArray<FavoriteIssue>(
							persistedState?.favorites,
							currentState.favorites,
						)
							.map(normalizeFavorite)
							.filter((favorite) => !!favorite.issueKey),
						(favorite) => favorite.issueKey,
					),
					templates: safeArray<RecurringTemplate>(
						persistedState?.templates,
						currentState.templates,
					)
						.map(normalizeTemplate)
						.filter((template) => !!template.issueKey),
					commentPresets: dedupeByCaseInsensitive(
						safeArray<string>(
							persistedState?.commentPresets,
							currentState.commentPresets,
						).filter((p): p is string => typeof p === 'string'),
						(preset) => preset,
					),
					dayNotes: safeStringRecord(
						persistedState?.dayNotes,
						currentState.dayNotes,
					),
					calendarMappings: mergeCalendarMappings(
						safeArray<CalendarMapping>(
							persistedState?.calendarMappings,
							currentState.calendarMappings,
						)
							.map(normalizeCalendarMapping)
							.filter(
								(mapping) => !!mapping.issueKey && mapping.patterns.length > 0,
							),
					),
					reportPresets: dedupeByCaseInsensitive(
						safeArray<ReportPreset>(
							persistedState?.reportPresets,
							currentState.reportPresets,
						)
							.map(normalizeReportPreset)
							.filter((preset) => !!preset.id && !!preset.label),
						(preset) => preset.id,
					),
				};
			},
		},
	),
);
