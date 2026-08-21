import type { Page } from '@playwright/test';

/**
 * Rail labels, from `frontend/react/constants/settingsSections.ts`. Kept as a
 * union so a renamed section breaks compilation here rather than producing a
 * click that silently times out.
 */
export type SettingsSection =
	| 'Connection'
	| 'Reports Scope'
	| 'Permissions'
	| 'Services'
	| 'Preferences'
	| 'Reminders'
	| 'Data & backup';

/**
 * Reveals one Settings section.
 *
 * The Settings redesign put the form behind a left rail: every section stays
 * mounted, but all except the active one carry `hidden`, so their fields are
 * present in the DOM and invisible to the user. Tests written before the rail
 * asserted straight against a field and now fail with "Received: hidden" —
 * which reads like a missing field but is a navigation step that no longer
 * happens implicitly.
 *
 * `exact` matters: the rail item "Data & backup" also matches a loose "Backup",
 * as does the Backup button inside the section it opens.
 */
export async function openSettingsSection(
	page: Page,
	section: SettingsSection,
): Promise<void> {
	await page
		.getByRole('navigation', { name: 'Settings sections' })
		.getByRole('button', { name: section, exact: true })
		.click();
}
