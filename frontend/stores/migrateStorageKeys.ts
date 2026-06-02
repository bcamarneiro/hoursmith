import { getPersistStorage } from './persistStorage';

/**
 * One-time rename of a persisted storage key (legacy `jira-timesheet-*` →
 * `hoursmith-*`). Hoursmith is browser-only, so every user's config, UI state,
 * and worklog data lives in localStorage under these keys — renaming the keys
 * without carrying the data forward would wipe existing users on next load.
 *
 * This copies the legacy value to the new key when the new key is absent, then
 * drops the legacy key. It is idempotent and cheap: once migrated (or on a fresh
 * install, or after another tab already migrated) it is a no-op. It MUST run
 * before the owning store hydrates — call it at module scope, above `create()`.
 */
export function migrateStorageKey(legacyKey: string, currentKey: string): void {
	try {
		const storage = getPersistStorage();
		// Already on the new key (migrated, or a fresh install that wrote it) —
		// never clobber current data with stale legacy data.
		if (storage.getItem(currentKey) !== null) return;
		const legacyValue = storage.getItem(legacyKey);
		if (legacyValue === null) return; // nothing to carry forward
		storage.setItem(currentKey, legacyValue);
		storage.removeItem(legacyKey);
	} catch {
		// localStorage can throw (private mode, quota, disabled storage). A failed
		// migration must never break startup — the store then hydrates empty, which
		// is exactly what would have happened before this rename existed.
	}
}
