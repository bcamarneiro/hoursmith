import { expect, test } from '@playwright/test';

/**
 * Real-browser check for the jira-timesheet-* → hoursmith-* localStorage rename
 * (ADA-351 / ADA-354). Hoursmith is browser-only, so every user's config, UI
 * state, and worklog data lives in localStorage — the rename ships a one-time
 * `migrateStorageKey` shim that must carry that data forward before the stores
 * hydrate, or existing users open the app to a blank slate.
 *
 * The unit tests (frontend/stores/__tests__/migrateStorageKeys.test.ts) cover the
 * function in isolation; this exercises it in a real page load through the actual
 * store modules.
 *
 * The seed is injected via addInitScript so it runs BEFORE the app bundle on the
 * one-and-only load — i.e. the real upgrade state: legacy keys present, no
 * hoursmith-* keys yet. (Booting the new build first would write a default
 * hoursmith-config, and the shim correctly refuses to clobber an existing new
 * key — which is the no-clobber unit test, not the carry-forward path.)
 *
 * Route is /my-week because it imports all four owners of a renamed key:
 * useConfigStore, useUIStore, useUserDataStore, and useComplianceReminder.
 */

const LEGACY = {
	'jira-timesheet-config': JSON.stringify({
		state: {
			config: { jiraHost: 'legacy.atlassian.net', email: 'legacy@example.com' },
		},
		version: 4,
	}),
	'jira-timesheet-ui': JSON.stringify({ state: { selectedTab: 'reports' } }),
	'jira-timesheet-userdata': JSON.stringify({
		state: { favorites: [{ id: 'HS-LEGACY', label: 'legacy favourite' }] },
	}),
	'jira-timesheet-last-reminded-week': '2026-W20',
};

test.describe('localStorage rename migration (ADA-351 / ADA-354)', () => {
	test('carries legacy jira-timesheet-* data forward to hoursmith-* on first load', async ({
		page,
	}) => {
		// Seed the pre-rename keys before any app code runs — the real upgrade state.
		await page.addInitScript((legacy) => {
			try {
				for (const [k, v] of Object.entries(legacy)) localStorage.setItem(k, v);
			} catch {
				/* origin without storage — ignored */
			}
		}, LEGACY);

		await page.goto('/my-week');
		await page.waitForLoadState('networkidle');

		const ls = await page.evaluate(() => ({
			config: localStorage.getItem('hoursmith-config'),
			ui: localStorage.getItem('hoursmith-ui'),
			userdata: localStorage.getItem('hoursmith-userdata'),
			reminded: localStorage.getItem('hoursmith-last-reminded-week'),
			legacyKeys: Object.keys(localStorage).filter((k) =>
				k.startsWith('jira-timesheet-'),
			),
		}));

		// Carry-forward proof on keys dev:offline does NOT seed: the migrated
		// favourite + compliance week are present under the new keys.
		// (NB: dev:offline force-seeds a mock Jira config, so hoursmith-config is
		// overwritten with mock creds post-migration — that's a dev-mode artifact,
		// not prod behaviour; the unit tests assert config carry-forward directly.)
		expect(ls.userdata).toContain('legacy favourite');
		expect(ls.reminded).toBe('2026-W20');
		// All renamed keys now exist...
		expect(ls.config).not.toBeNull();
		expect(ls.ui).not.toBeNull();
		// ...and every legacy key is gone (the shim copies then removes).
		expect(ls.legacyKeys).toEqual([]);
	});

	test('a fresh install (no legacy keys) leaves no jira-timesheet-* keys behind', async ({
		page,
	}) => {
		await page.goto('/my-week');
		await page.waitForLoadState('networkidle');

		const legacyKeys = await page.evaluate(() =>
			Object.keys(localStorage).filter((k) => k.startsWith('jira-timesheet-')),
		);
		expect(legacyKeys).toEqual([]);
	});
});
