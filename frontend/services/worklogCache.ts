import { openDB, type IDBPDatabase } from 'idb';
import type { EnrichedJiraWorklog } from '../../types/jira';
import { logger } from '../react/utils/logger';

const DB_NAME = 'hoursmith-worklog-cache';
const DB_VERSION = 1;
const STORE_NAME = 'monthCache';

/**
 * Key shape: `${connectionScope}::${year}-${month}`
 * connectionScope is a hash of jiraHost + email to scope data per-connection
 * and ensure clearing on sign-out removes only that connection's data.
 */
interface MonthCacheEntry {
	worklogs: EnrichedJiraWorklog[];
	lastSyncTime: string; // ISO timestamp of last successful sync
	fetchedAt: number; // epoch ms when this entry was written
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
	if (!dbPromise) {
		dbPromise = openDB(DB_NAME, DB_VERSION, {
			upgrade(db) {
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME);
				}
			},
		});
	}
	return dbPromise;
}

/**
 * Build a connection scope key from host + email.
 * Deliberately excludes apiToken and corsProxy so rotating a token
 * doesn't invalidate the cache (the data is the same).
 */
export function buildConnectionScope(jiraHost: string, email: string): string {
	return `${jiraHost.trim().toLowerCase()}::${email.trim().toLowerCase()}`;
}

function cacheKey(connectionScope: string, year: number, month: number): string {
	return `${connectionScope}::${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * Check if IndexedDB caching is available in this environment.
 * Returns false in SSR, private browsing with blocked IDB, etc.
 */
export function isIndexedDBAvailable(): boolean {
	try {
		return typeof indexedDB !== 'undefined' && indexedDB !== null;
	} catch {
		return false;
	}
}

/**
 * Read cached worklogs for a given month + connection.
 * Returns null if no cache entry exists.
 */
export async function getCachedWorklogs(
	connectionScope: string,
	year: number,
	month: number,
): Promise<MonthCacheEntry | null> {
	if (!isIndexedDBAvailable()) return null;
	try {
		const db = await getDb();
		const entry = await db.get(STORE_NAME, cacheKey(connectionScope, year, month));
		return entry ?? null;
	} catch (err) {
		logger.debug(`[worklogCache] getCachedWorklogs failed: ${err}`);
		return null;
	}
}

/**
 * Store worklogs for a given month + connection.
 * Sets lastSyncTime to now and fetchedAt to current epoch ms.
 */
export async function storeWorklogs(
	connectionScope: string,
	year: number,
	month: number,
	worklogs: EnrichedJiraWorklog[],
): Promise<void> {
	if (!isIndexedDBAvailable()) return;
	try {
		const db = await getDb();
		const entry: MonthCacheEntry = {
			worklogs,
			lastSyncTime: new Date().toISOString(),
			fetchedAt: Date.now(),
		};
		await db.put(STORE_NAME, entry, cacheKey(connectionScope, year, month));
	} catch (err) {
		logger.debug(`[worklogCache] storeWorklogs failed: ${err}`);
	}
}

/**
 * Merge new worklogs into existing cached data.
 * Uses worklog id as the dedup key — new entries upsert, removed entries
 * are NOT pruned (they may still be valid; a full refresh handles that).
 */
export async function mergeWorklogs(
	connectionScope: string,
	year: number,
	month: number,
	newWorklogs: EnrichedJiraWorklog[],
): Promise<EnrichedJiraWorklog[]> {
	if (!isIndexedDBAvailable()) return newWorklogs;
	try {
		const existing = await getCachedWorklogs(connectionScope, year, month);
		const merged = [...(existing?.worklogs ?? [])];
		const idMap = new Map<string, number>();

		// Index existing by worklog id
		for (let i = 0; i < merged.length; i++) {
			const id = merged[i].id;
			if (id) idMap.set(id, i);
		}

		// Upsert new worklogs
		for (const wl of newWorklogs) {
			if (wl.id && idMap.has(wl.id)) {
				merged[idMap.get(wl.id)!] = wl;
			} else {
				merged.push(wl);
			}
		}

		await storeWorklogs(connectionScope, year, month, merged);
		return merged;
	} catch (err) {
		logger.debug(`[worklogCache] mergeWorklogs failed: ${err}`);
		return newWorklogs;
	}
}

/**
 * Clear all cached data for a specific connection scope.
 * Called on sign-out or connection change.
 */
export async function clearConnectionCache(connectionScope: string): Promise<void> {
	if (!isIndexedDBAvailable()) return;
	try {
		const db = await getDb();
		const tx = db.transaction(STORE_NAME, 'readwrite');
		const store = tx.objectStore(STORE_NAME);

		// Iterate all keys and delete those matching this connection scope
		let cursor = await store.openCursor();
		while (cursor) {
			const key = cursor.key as string;
			if (key.startsWith(`${connectionScope}::`)) {
				await cursor.delete();
			}
			cursor = await cursor.continue();
		}
		await tx.done;
	} catch (err) {
		logger.debug(`[worklogCache] clearConnectionCache failed: ${err}`);
	}
}

/**
 * Clear ALL cached worklog data.
 * Called on account delete or full reset.
 */
export async function clearAllCache(): Promise<void> {
	if (!isIndexedDBAvailable()) return;
	try {
		const db = await getDb();
		await db.clear(STORE_NAME);
	} catch (err) {
		logger.debug(`[worklogCache] clearAllCache failed: ${err}`);
	}
}

/**
 * Reset the DB connection (for testing).
 */
export function _resetDbConnection(): void {
	dbPromise = null;
}
