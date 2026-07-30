/**
 * Nager.Date API Client & Holiday Cache (ADA-584).
 *
 * Fetches public holidays from https://date.nager.at/api/v3
 * with an in-memory cache keyed by `${countryCode}-${year}`.
 *
 * TTL defaults to 1 hour and is configurable via `setCacheTTL`.
 */

import { logger } from '../react/utils/logger';
import { fromHttpResponse, fromNetworkError, ServiceError } from './serviceErrors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NagerHoliday {
	date: string;
	localName: string;
	name: string;
	countryCode: string;
	fixed: boolean;
	global: boolean;
	counties: string[] | null;
	launchYear: number | null;
	types: string[];
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
	data: NagerHoliday[];
	expiresAt: number;
}

let cacheTTL = 60 * 60 * 1000; // 1 hour default
const cache = new Map<string, CacheEntry>();

/**
 * Set a custom TTL for cached holiday data (in milliseconds).
 */
export function setCacheTTL(ttlMs: number): void {
	cacheTTL = ttlMs;
}

function cacheKey(countryCode: string, year: number): string {
	return `${countryCode.toUpperCase()}-${year}`;
}

/**
 * Retrieve cached holidays if the entry hasn't expired.
 */
function cacheGet(countryCode: string, year: number): NagerHoliday[] | null {
	const key = cacheKey(countryCode, year);
	const entry = cache.get(key);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		cache.delete(key);
		return null;
	}
	return entry.data;
}

function cacheSet(countryCode: string, year: number, data: NagerHoliday[]): void {
	const key = cacheKey(countryCode, year);
	cache.set(key, { data, expiresAt: Date.now() + cacheTTL });
}

/**
 * Clear the entire holiday cache.
 */
export function clearHolidayCache(): void {
	cache.clear();
}

/**
 * Invalidate a specific country/year entry.
 */
export function invalidateHolidayCache(countryCode: string, year: number): void {
	cache.delete(cacheKey(countryCode, year));
}

// ---------------------------------------------------------------------------
// API constants
// ---------------------------------------------------------------------------

const NAGER_API_BASE = 'https://date.nager.at/api/v3';

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch public holidays for a given country and year from the Nager.Date API.
 *
 * Results are cached in memory keyed by `${countryCode}-${year}` with a
 * configurable TTL (default 1 hour).
 *
 * @param countryCode ISO 3166-1 alpha-2 country code (e.g. "PT", "US", "DE")
 * @param year        Calendar year (e.g. 2024)
 * @param signal      Optional AbortSignal for request cancellation
 */
export async function fetchPublicHolidays(
	countryCode: string,
	year: number,
	signal?: AbortSignal,
): Promise<NagerHoliday[]> {
	const code = countryCode.trim().toUpperCase();
	if (!code || code.length !== 2) {
		throw new ServiceError({
			kind: 'unknown',
			source: 'Nager.Date',
			message: `Invalid country code: "${countryCode}". Expected ISO 3166-1 alpha-2.`,
		});
	}
	if (!Number.isInteger(year) || year < 1900 || year > 2100) {
		throw new ServiceError({
			kind: 'unknown',
			source: 'Nager.Date',
			message: `Invalid year: ${year}. Must be an integer between 1900 and 2100.`,
		});
	}

	// Check cache first
	const cached = cacheGet(code, year);
	if (cached) {
		logger.debug(`[Nager.Date] Cache hit for ${code}/${year}`);
		return cached;
	}

	logger.debug(`[Nager.Date] Fetching holidays for ${code}/${year}`);
	const url = `${NAGER_API_BASE}/PublicHolidays/${year}/${code}`;

	let res: Response;
	try {
		res = await fetch(url, signal ? { signal } : undefined);
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') {
			throw err;
		}
		throw fromNetworkError('Nager.Date', err);
	}

	if (!res.ok) {
		throw fromHttpResponse('Nager.Date', res.status);
	}

	let data: NagerHoliday[];
	try {
		data = (await res.json()) as NagerHoliday[];
	} catch {
		throw new ServiceError({
			kind: 'unknown',
			source: 'Nager.Date',
			message: 'Nager.Date: invalid JSON response',
		});
	}

	cacheSet(code, year, data);
	return data;
}
