export const SETTINGS_SECTION_IDS = {
	form: 'settings-form',
	connection: 'settings-connection',
	scope: 'settings-scope',
	permissions: 'settings-permissions',
	integrations: 'settings-integrations',
	calendarMappings: 'settings-calendar-mappings',
	preferences: 'settings-preferences',
} as const;

export type SettingsSectionId =
	(typeof SETTINGS_SECTION_IDS)[keyof typeof SETTINGS_SECTION_IDS];

/**
 * Left-rail navigation for the Settings form (redesign Phase 3). Each rail item
 * maps to one of the existing form sections; the rail only reorganises how the
 * unchanged section components are presented. `setupKey` links a rail item to a
 * step/diagnostic in `buildSettingsSetupModel` so the rail can show a live
 * status dot without any new state.
 */
export interface SettingsRailItem {
	/** DOM id of the section (one of SETTINGS_SECTION_IDS values). */
	id: string;
	/** Rail label (matches the existing section legend). */
	label: string;
	/** Setup-model step id used to resolve the status dot, if any. */
	setupKey?: 'connection' | 'scope' | 'permissions' | 'signals' | 'verify';
	/** Grouping: 'config' = Configuration, 'saved' = Saved state. */
	group: 'config' | 'saved';
}

export const SETTINGS_RAIL_ITEMS: SettingsRailItem[] = [
	{
		id: SETTINGS_SECTION_IDS.connection,
		label: 'Connection',
		setupKey: 'connection',
		group: 'config',
	},
	{
		id: SETTINGS_SECTION_IDS.scope,
		label: 'Reports Scope',
		setupKey: 'scope',
		group: 'config',
	},
	{
		id: SETTINGS_SECTION_IDS.permissions,
		label: 'Permissions',
		setupKey: 'permissions',
		group: 'config',
	},
	{
		id: SETTINGS_SECTION_IDS.integrations,
		label: 'Services',
		setupKey: 'signals',
		group: 'config',
	},
	{
		id: SETTINGS_SECTION_IDS.preferences,
		label: 'Preferences',
		group: 'config',
	},
	{
		id: SETTINGS_SECTION_IDS.form,
		label: 'Data & backup',
		setupKey: 'verify',
		group: 'saved',
	},
];
