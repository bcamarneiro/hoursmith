import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearHolidayCache,
	fetchPublicHolidays,
	invalidateHolidayCache,
	setCacheTTL,
} from '../nagerDateService';
import type { NagerHoliday } from '../nagerDateService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const portugalHolidays2024: NagerHoliday[] = [
	{
		date: '2024-01-01',
		localName: 'Dia de Ano Novo',
		name: "New Year's Day",
		countryCode: 'PT',
		fixed: true,
		global: true,
		counties: null,
		launchYear: null,
		types: ['Public'],
	},
	{
		date: '2024-04-25',
		localName: 'Dia da Liberdade',
		name: 'Freedom Day',
		countryCode: 'PT',
		fixed: false,
		global: true,
		counties: null,
		launchYear: 1974,
		types: ['Public'],
	},
	{
		date: '2024-12-25',
		localName: 'Natal',
		name: 'Christmas Day',
		countryCode: 'PT',
		fixed: true,
		global: true,
		counties: null,
		launchYear: null,
		types: ['Public'],
	},
];

const germanyHolidays2024: NagerHoliday[] = [
	{
		date: '2024-01-01',
		localName: 'Neujahr',
		name: "New Year's Day",
		countryCode: 'DE',
		fixed: true,
		global: true,
		counties: null,
		launchYear: null,
		types: ['Public'],
	},
	{
		date: '2024-10-03',
		localName: 'Tag der Deutschen Einheit',
		name: 'German Unity Day',
		countryCode: 'DE',
		fixed: true,
		global: true,
		counties: null,
		launchYear: 1990,
		types: ['Public'],
	},
];

/**
 * Replace the global fetch with a mock that returns the given data.
 * Uses mockImplementation to avoid resetting call count on repeated use.
 */
function mockFetchResponse(data: unknown, status = 200): void {
	const response = {
		ok: status >= 200 && status < 300,
		status,
		json: async () => data,
	} as unknown as Response;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const fetchMock = global.fetch as any;
	if (fetchMock.mockResolvedValue) {
		fetchMock.mockResolvedValue(response);
	} else {
		vi.spyOn(global, 'fetch').mockResolvedValue(response);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nagerDateService', () => {
	beforeEach(() => {
		clearHolidayCache();
		setCacheTTL(60 * 60 * 1000); // reset to 1h default
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -- happy path ----------------------------------------------------------

	it('fetches public holidays for a given country and year', async () => {
		mockFetchResponse(portugalHolidays2024);

		const result = await fetchPublicHolidays('PT', 2024);

		expect(result).toEqual(portugalHolidays2024);
		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(global.fetch).toHaveBeenCalledWith(
			'https://date.nager.at/api/v3/PublicHolidays/2024/PT',
			undefined,
		);
	});

	// -- caching -------------------------------------------------------------

	it('returns cached data on subsequent calls for the same country/year', async () => {
		mockFetchResponse(portugalHolidays2024);

		const first = await fetchPublicHolidays('PT', 2024);
		expect(first).toEqual(portugalHolidays2024);
		expect(global.fetch).toHaveBeenCalledTimes(1);

		const second = await fetchPublicHolidays('PT', 2024);
		expect(second).toEqual(portugalHolidays2024);
		// No additional fetch — cache hit
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('returns fresh data for different country/year combinations', async () => {
		vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/2024/PT')) {
				return { ok: true, status: 200, json: async () => portugalHolidays2024 } as Response;
			}
			if (url.includes('/2024/DE')) {
				return { ok: true, status: 200, json: async () => germanyHolidays2024 } as Response;
			}
			return { ok: false, status: 404 } as unknown as Response;
		});

		const pt = await fetchPublicHolidays('PT', 2024);
		expect(pt).toEqual(portugalHolidays2024);

		const de = await fetchPublicHolidays('DE', 2024);
		expect(de).toEqual(germanyHolidays2024);

		// PT cached on subsequent call
		const ptAgain = await fetchPublicHolidays('PT', 2024);
		expect(ptAgain).toEqual(portugalHolidays2024);

		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('honours custom TTL for cache expiry', async () => {
		vi.useFakeTimers();
		mockFetchResponse(portugalHolidays2024);

		// Very short TTL — 10ms
		setCacheTTL(10);

		await fetchPublicHolidays('PT', 2024);
		expect(global.fetch).toHaveBeenCalledTimes(1);

		// Advance time past TTL
		vi.advanceTimersByTime(11);

		mockFetchResponse(germanyHolidays2024);
		const result = await fetchPublicHolidays('PT', 2024);
		expect(global.fetch).toHaveBeenCalledTimes(2);
		expect(result).toEqual(germanyHolidays2024);

		vi.useRealTimers();
	});

	it('clears all cached entries when clearHolidayCache is called', async () => {
		mockFetchResponse(portugalHolidays2024);
		await fetchPublicHolidays('PT', 2024);
		expect(global.fetch).toHaveBeenCalledTimes(1);

		clearHolidayCache();

		mockFetchResponse(germanyHolidays2024);
		const result = await fetchPublicHolidays('PT', 2024);
		expect(global.fetch).toHaveBeenCalledTimes(2);
		expect(result).toEqual(germanyHolidays2024);
	});

	it('invalidates a specific country/year entry via invalidateHolidayCache', async () => {
		mockFetchResponse(portugalHolidays2024);
		await fetchPublicHolidays('PT', 2024);
		await fetchPublicHolidays('DE', 2024);
		expect(global.fetch).toHaveBeenCalledTimes(2);

		invalidateHolidayCache('PT', 2024);

		mockFetchResponse(germanyHolidays2024);
		const pt = await fetchPublicHolidays('PT', 2024);
		expect(global.fetch).toHaveBeenCalledTimes(3);

		// DE should still be cached (with the data it was originally fetched with)
		const de = await fetchPublicHolidays('DE', 2024);
		expect(de).toEqual(portugalHolidays2024);
		expect(global.fetch).toHaveBeenCalledTimes(3);
	});

	it('normalizes the country code to uppercase for cache keys', async () => {
		mockFetchResponse(portugalHolidays2024);

		await fetchPublicHolidays('pt', 2024);
		expect(global.fetch).toHaveBeenCalledTimes(1);

		const result = await fetchPublicHolidays('PT', 2024);
		expect(result).toEqual(portugalHolidays2024);
		expect(global.fetch).toHaveBeenCalledTimes(1); // cache hit
	});

	// -- validation ----------------------------------------------------------

	it('throws for an invalid country code (not 2 characters)', async () => {
		await expect(fetchPublicHolidays('USA', 2024)).rejects.toThrow(
			'Invalid country code',
		);
		await expect(fetchPublicHolidays('', 2024)).rejects.toThrow(
			'Invalid country code',
		);
		await expect(fetchPublicHolidays('   ', 2024)).rejects.toThrow(
			'Invalid country code',
		);
		await expect(fetchPublicHolidays('X', 2024)).rejects.toThrow(
			'Invalid country code',
		);
	});

	it('throws for an invalid year', async () => {
		await expect(fetchPublicHolidays('PT', 1899)).rejects.toThrow(
			'Invalid year',
		);
		await expect(fetchPublicHolidays('PT', 2101)).rejects.toThrow(
			'Invalid year',
		);
		await expect(fetchPublicHolidays('PT', 0)).rejects.toThrow(
			'Invalid year',
		);
		await expect(fetchPublicHolidays('PT', -1)).rejects.toThrow(
			'Invalid year',
		);
	});

	// -- error handling ------------------------------------------------------

	it('throws a ServiceError on HTTP 404', async () => {
		mockFetchResponse(null, 404);

		await expect(fetchPublicHolidays('XX', 2024)).rejects.toMatchObject({
			source: 'Nager.Date',
			status: 404,
		});
	});

	it('throws a ServiceError on HTTP 500', async () => {
		mockFetchResponse(null, 500);

		await expect(fetchPublicHolidays('PT', 2024)).rejects.toMatchObject({
			source: 'Nager.Date',
			status: 500,
		});
	});

	it('throws a ServiceError on network error', async () => {
		vi.spyOn(global, 'fetch').mockRejectedValue(
			new TypeError('Failed to fetch'),
		);

		await expect(fetchPublicHolidays('PT', 2024)).rejects.toMatchObject({
			source: 'Nager.Date',
		});
	});

	it('throws on invalid JSON response', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			json: async () => {
				throw new Error('JSON parse error');
			},
		} as unknown as Response);

		await expect(fetchPublicHolidays('PT', 2024)).rejects.toMatchObject({
			source: 'Nager.Date',
		});
	});

	it('re-throws an AbortError from the AbortSignal without wrapping', async () => {
		const abortError = new DOMException(
			'The operation was aborted',
			'AbortError',
		);
		vi.spyOn(global, 'fetch').mockRejectedValue(abortError);

		await expect(fetchPublicHolidays('PT', 2024)).rejects.toThrow(abortError);
	});

	it('passes the AbortSignal to fetch', async () => {
		mockFetchResponse(portugalHolidays2024);

		const controller = new AbortController();
		await fetchPublicHolidays('PT', 2024, controller.signal);

		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(global.fetch).toHaveBeenCalledWith(
			'https://date.nager.at/api/v3/PublicHolidays/2024/PT',
			{ signal: controller.signal },
		);
	});

	// -- edge cases ----------------------------------------------------------

	it('handles an empty holiday list from the API', async () => {
		mockFetchResponse([]);

		const result = await fetchPublicHolidays('PT', 2024);
		expect(result).toEqual([]);
	});
});
