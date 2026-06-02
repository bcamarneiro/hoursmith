import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { migrateStorageKey } from './migrateStorageKeys';
import { getPersistStorage } from './persistStorage';
import type { Config } from './useConfigStore';

interface UIPreferences {
	hideWeekends: boolean;
	compactView: boolean;
}

interface UIState {
	// Current active tab/page
	selectedTab: 'home' | 'timesheet' | 'settings';

	// User preferences
	preferences: UIPreferences;

	// Filters
	selectedProject: string;

	// Expanded state for collapsible sections (user: boolean)
	expandedUsers: Record<string, boolean>;

	// Product adoption preferences
	installPromptDismissed: boolean;

	// Persisted evidence that the saved Jira connection has already worked
	jiraConnectionEvidenceAt: string | null;
	jiraConnectionEvidenceFingerprint: string | null;
	jiraConnectionEvidenceSource: 'test' | 'fetch' | null;

	// Actions
	setSelectedTab: (tab: 'home' | 'timesheet' | 'settings') => void;
	updatePreferences: (prefs: Partial<UIPreferences>) => void;
	setSelectedProject: (project: string) => void;
	toggleUserExpanded: (user: string) => void;
	resetPreferences: () => void;
	dismissInstallPrompt: () => void;
	resetInstallPrompt: () => void;
	markJiraConnectionEvidence: (
		fingerprint: string,
		source: 'test' | 'fetch',
		at?: string,
	) => void;
	clearJiraConnectionEvidence: () => void;
}

export const UI_STORAGE_VERSION = 2;

const defaultPreferences: UIPreferences = {
	hideWeekends: false,
	compactView: false,
};

function normalizeExpandedUsers(
	expandedUsers: unknown,
): Record<string, boolean> {
	if (!expandedUsers || typeof expandedUsers !== 'object') {
		return {};
	}

	return Object.fromEntries(
		Object.entries(expandedUsers).filter(
			([user, expanded]) => !!user.trim() && expanded === true,
		),
	);
}

function normalizeUIPersistedState(persisted: Partial<UIState> | undefined) {
	const jiraConnectionEvidenceAt =
		typeof persisted?.jiraConnectionEvidenceAt === 'string'
			? persisted.jiraConnectionEvidenceAt
			: null;
	const jiraConnectionEvidenceFingerprint =
		typeof persisted?.jiraConnectionEvidenceFingerprint === 'string' &&
		persisted.jiraConnectionEvidenceFingerprint.trim()
			? persisted.jiraConnectionEvidenceFingerprint
			: null;
	const jiraConnectionEvidenceSource =
		persisted?.jiraConnectionEvidenceSource === 'test' ||
		persisted?.jiraConnectionEvidenceSource === 'fetch'
			? persisted.jiraConnectionEvidenceSource
			: null;

	return {
		preferences: {
			...defaultPreferences,
			...(persisted?.preferences ?? {}),
		},
		selectedProject:
			typeof persisted?.selectedProject === 'string'
				? persisted.selectedProject.trim().toUpperCase()
				: '',
		expandedUsers: normalizeExpandedUsers(persisted?.expandedUsers),
		installPromptDismissed: persisted?.installPromptDismissed === true,
		jiraConnectionEvidenceAt:
			jiraConnectionEvidenceAt && jiraConnectionEvidenceFingerprint
				? jiraConnectionEvidenceAt
				: null,
		jiraConnectionEvidenceFingerprint,
		jiraConnectionEvidenceSource:
			jiraConnectionEvidenceAt && jiraConnectionEvidenceFingerprint
				? jiraConnectionEvidenceSource
				: null,
	};
}

export function buildJiraConnectionFingerprint(
	config: Pick<Config, 'jiraHost' | 'email' | 'apiToken' | 'corsProxy'>,
): string {
	return [
		config.jiraHost.trim().toLowerCase(),
		config.email.trim().toLowerCase(),
		config.apiToken.trim(),
		config.corsProxy.trim(),
	].join('::');
}

export function migratePersistedUIState(
	persisted: unknown,
	version: number,
): Partial<UIState> {
	const persistedState = persisted as Partial<UIState> | undefined;

	if (version < UI_STORAGE_VERSION) {
		return normalizeUIPersistedState(persistedState);
	}

	return normalizeUIPersistedState(persistedState);
}

// Carry existing users' data across the jira-timesheet-report → hoursmith rename.
migrateStorageKey('jira-timesheet-ui', 'hoursmith-ui');

export const useUIStore = create<UIState>()(
	persist(
		(set) => ({
			selectedTab: 'home',
			preferences: defaultPreferences,
			selectedProject: '',
			expandedUsers: {},
			installPromptDismissed: false,
			jiraConnectionEvidenceAt: null,
			jiraConnectionEvidenceFingerprint: null,
			jiraConnectionEvidenceSource: null,

			setSelectedTab: (tab: 'home' | 'timesheet' | 'settings') => {
				set({ selectedTab: tab });
			},

			updatePreferences: (prefs: Partial<UIPreferences>) => {
				set((state) => ({
					preferences: {
						...state.preferences,
						...prefs,
					},
				}));
			},

			setSelectedProject: (project: string) => {
				set({ selectedProject: project.trim().toUpperCase() });
			},

			toggleUserExpanded: (user: string) => {
				set((state) => {
					const next = !state.expandedUsers[user];
					if (next) {
						return {
							expandedUsers: {
								...state.expandedUsers,
								[user]: true,
							},
						};
					}
					const expandedUsers = { ...state.expandedUsers };
					delete expandedUsers[user];
					return { expandedUsers };
				});
			},

			resetPreferences: () => {
				set({ preferences: defaultPreferences });
			},

			dismissInstallPrompt: () => {
				set({ installPromptDismissed: true });
			},

			resetInstallPrompt: () => {
				set({ installPromptDismissed: false });
			},

			markJiraConnectionEvidence: (fingerprint, source, at) => {
				set({
					jiraConnectionEvidenceAt: at ?? new Date().toISOString(),
					jiraConnectionEvidenceFingerprint: fingerprint,
					jiraConnectionEvidenceSource: source,
				});
			},

			clearJiraConnectionEvidence: () => {
				set({
					jiraConnectionEvidenceAt: null,
					jiraConnectionEvidenceFingerprint: null,
					jiraConnectionEvidenceSource: null,
				});
			},
		}),
		{
			name: 'hoursmith-ui',
			storage: createJSONStorage(getPersistStorage),
			version: UI_STORAGE_VERSION,
			migrate: (persistedState, version) =>
				migratePersistedUIState(persistedState, version),
			partialize: (state) => ({
				preferences: state.preferences,
				selectedProject: state.selectedProject,
				expandedUsers: state.expandedUsers,
				installPromptDismissed: state.installPromptDismissed,
				jiraConnectionEvidenceAt: state.jiraConnectionEvidenceAt,
				jiraConnectionEvidenceFingerprint:
					state.jiraConnectionEvidenceFingerprint,
				jiraConnectionEvidenceSource: state.jiraConnectionEvidenceSource,
			}),
			merge: (persisted, current) => {
				const persistedState = normalizeUIPersistedState(
					persisted as Partial<UIState> | undefined,
				);
				return {
					...current,
					...persistedState,
				};
			},
		},
	),
);
