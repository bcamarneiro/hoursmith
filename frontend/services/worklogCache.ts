/**
 * IndexedDB persistence layer for worklog data.
 *
 * Privacy guard: opt-in (default off), scoped per-connection fingerprint,
 * user-clearable, and cleared on sign-out / connection change.
 *
 * Stores fetched worklogs per (connection, year-month) key so repeat visits
 * can skip full re-fetches and only pull the delta (worklogs updated since
 * lastSyncTime).
 */
import type { EnrichedJiraWorklog } from '../../types/jira';

const DB_NAME = 'hoursmith-worklog-cache';
const DB_VERSION = 1;
const STORE_WORKLOGS = 'month-worklogs';
const STORE_META = 'sync-meta';

/** Key shape for the worklogs object store: `${fingerprint}:${year}-${month}` */
function monthKey(fingerprint: string, year: number, month: number): string {
	return `${fingerprint}:${year}-${String(month).padStart(2, '0')}`;
}

/** Key shape for the sync-meta object store: same as monthKey */
function metaKey(fingerprint: string, year: number, month: number): string {
	return monthKey(fingerprint, year, month);
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;

	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			reject(new Error('IndexedDB unavailable'));
			return;
		}

		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_WORKLOGS)) {
				db.createObjectStore(STORE_WORKLOGS);
			}
			if (!db.objectStoreNames.contains(STORE_META)) {
				db.createObjectStore(STORE_META);
			}
		};

		request.onsuccess = () => {
			const db = request.result;
			db.onclose = () => {
				dbPromise = null;
			};
			resolve(db);
		};

		request.onerror = () => {
			dbPromise = null;
			reject(request.error);
		};
	});

	return dbPromise;
}

/**
 * Save worklogs for a given month + connection. Also records the sync
 * timestamp so subsequent loads can do a delta fetch.
 */
export async function saveMonthWorklogs(
	fingerprint: string,
	year: number,
	month: number,
	worklogs: EnrichedJiraWorklog[],
): Promise<void> {
	const db = await openDB();
	const key = monthKey(fingerprint, year, month);

	return new Promise<void>((resolve, reject) => {
		const tx = db.transaction([STORE_WORKLOGS, STORE_META], 'readwrite');

		tx.objectStore(STORE_WORKLOGS).put(worklogs, key);
		tx.objectStore(STORE_META).put(
			{ syncedAt: new Date().toISOString() },
			metaKey(fingerprint, year, month),
		);

		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/**
 * Load cached worklogs for a given month + connection.
 * Returns null if nothing is cached.
 */
export async function loadMonthWorklogs(
	fingerprint: string,
	year: number,
	month: number,
): Promise<EnrichedJiraWorklog[] | null> {
	const db = await openDB();
	const key = monthKey(fingerprint, year, month);

	return new Promise<EnrichedJiraWorklog[] | null>((resolve, reject) => {
		const tx = db.transaction(STORE_WORKLOGS, 'readonly');
		const request = tx.objectStore(STORE_WORKLOGS).get(key);

		request.onsuccess = () => {
			resolve(request.result ?? null);
		};
		request.onerror = () => reject(request.error);
	});
}

/**
 * Get the last sync timestamp for a given month + connection.
 * Returns null if no sync has been recorded.
 */
export async function getMonthSyncTime(
	fingerprint: string,
	year: number,
	month: number,
): Promise<string | null> {
	const db = await openDB();
	const key = metaKey(fingerprint, year, month);

	return new Promise<string | null>((resolve, reject) => {
		const tx = db.transaction(STORE_META, 'readonly');
		const request = tx.objectStore(STORE_META).get(key);

		request.onsuccess = () => {
			const meta = request.result as { syncedAt?: string } | undefined;
			resolve(meta?.syncedAt ?? null);
		};
		request.onerror = () => reject(request.error);
	});
}

/**
 * Clear all cached data for a specific connection fingerprint.
 * Called on sign-out or when the user changes their Jira connection.
 */
export async function clearConnectionCache(fingerprint: string): Promise<void> {
	const db = await openDB();

	return new Promise<void>((resolve, reject) => {
		const tx = db.transaction([STORE_WORKLOGS, STORE_META], 'readwrite');

		// Iterate and delete keys that start with the fingerprint prefix
		const prefix = `${fingerprint}:`;

		const worklogsStore = tx.objectStore(STORE_WORKLOGS);
		const worklogsCursor = worklogsStore.openCursor();
		worklogsCursor.onsuccess = () => {
			const cursor = worklogsCursor.result;
			if (cursor) {
				if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
					cursor.delete();
				}
				cursor.continue();
			}
		};

		const metaStore = tx.objectStore(STORE_META);
		const metaCursor = metaStore.openCursor();
		metaCursor.onsuccess = () => {
			const cursor = metaCursor.result;
			if (cursor) {
				if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
					cursor.delete();
				}
				cursor.continue();
			}
		};

		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/**
 * Clear ALL cached worklog data across all connections.
 * Called when the user explicitly clears cached data from settings.
 */
export async function clearAllCache(): Promise<void> {
	const db = await openDB();

	return new Promise<void>((resolve, reject) => {
		const tx = db.transaction([STORE_WORKLOGS, STORE_META], 'readwrite');

		tx.objectStore(STORE_WORKLOGS).clear();
		tx.objectStore(STORE_META).clear();

		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/**
 * Merge delta worklogs into a cached set. Uses worklog `id` as the
 * deduplication key — newer entries (by `updated` timestamp) replace older
 * ones. Returns the merged array.
 */
export function mergeWorklogs(
	cached: EnrichedJiraWorklog[],
	delta: EnrichedJiraWorklog[],
): EnrichedJiraWorklog[] {
	const byId = new Map<string, EnrichedJiraWorklog>();

	for (const wl of cached) {
		const id = wl.id ?? `${wl.issue?.key}:${wl.started}:${wl.timeSpentSeconds}`;
		byId.set(id, wl);
	}

	for (const wl of delta) {
		const id = wl.id ?? `${wl.issue?.key}:${wl.started}:${wl.timeSpentSeconds}`;
		const existing = byId.get(id);
		if (!existing || (wl.updated && existing.updated && wl.updated > existing.updated)) {
			byId.set(id, wl);
		}
	}

	return Array.from(byId.values());
}
