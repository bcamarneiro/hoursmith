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

	// Transient flag: at least one worklog author looks like the Tempo app account
	tempoSuspected: boolean;
	/**
	 * Which Jira *instance* the suspicion belongs to — see
	 * `buildTempoInstanceKey`. Persisted with the flag so detection survives a
	 * reload: without it, `auto` (the default) resolves to Jira on every cold
	 * load until a read completes, and a write in that window goes to the wrong
	 * backend. Scoped so switching jiraHost does not carry the suspicion to an
	 * instance that has no Tempo.
	 */
	tempoSuspectedFingerprint: string | null;

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
	setTempoSuspected: (v: boolean, fingerprint?: string) => void;
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

export function normalizeUIPersistedState(
	persisted: Partial<UIState> | undefined,
) {
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
		// Must be listed here, not only in `partialize`: `merge` spreads this
		// object over the defaults, so any key omitted below is reset on every
		// load — which made persisting the flag a no-op.
		//
		// A suspicion with no fingerprint is dropped rather than trusted: it
		// cannot be scoped to an instance, so it would apply to whatever Jira is
		// configured next, including one with no Tempo.
		tempoSuspected:
			persisted?.tempoSuspected === true &&
			typeof persisted?.tempoSuspectedFingerprint === 'string' &&
			persisted.tempoSuspectedFingerprint.trim().length > 0,
		tempoSuspectedFingerprint:
			typeof persisted?.tempoSuspectedFingerprint === 'string' &&
			persisted.tempoSuspectedFingerprint.trim()
				? persisted.tempoSuspectedFingerprint
				: null,
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

/**
 * Identity of the Jira *instance*, for scoping Tempo detection.
 *
 * Deliberately not `buildJiraConnectionFingerprint`: that includes the proxy,
 * and the proxy differs by code path — hooks that use `useEffectiveProxyUrl`
 * (My Week, the trend chart) see the hosted relay while others see the raw
 * configured value. Keying on it made the recorded and compared fingerprints
 * disagree for hosted users, so detection was ignored entirely and `auto` mode
 * flapped depending on which read ran last.
 *
 * Whether Tempo manages an instance is a property of the instance, not of how
 * the request reaches it.
 */
export function buildTempoInstanceKey(
	config: Pick<Config, 'jiraHost' | 'email'>,
): string {
	return [
		config.jiraHost.trim().toLowerCase(),
		config.email.trim().toLowerCase(),
	].join('::');
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
			tempoSuspected: false,
			tempoSuspectedFingerprint: null,
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

			setTempoSuspected: (v: boolean, fingerprint?: string) =>
				set({
					tempoSuspected: v,
					tempoSuspectedFingerprint: v ? (fingerprint ?? null) : null,
				}),

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
				tempoSuspected: state.tempoSuspected,
				tempoSuspectedFingerprint: state.tempoSuspectedFingerprint,
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
