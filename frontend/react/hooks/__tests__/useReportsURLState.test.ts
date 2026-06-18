import { afterEach, describe, expect, it } from 'vitest';
import {
	getInitialViewModeFromURL,
	parseReportsURLParams,
} from '../useReportsURLState';

describe('parseReportsURLParams', () => {
	it('parses a canonical reports URL', () => {
		const parsed = parseReportsURLParams(
			'?view=monthly&year=2025&month=10&user=Sarah%20Johnson&sort=total&dir=desc&q=PROJ&trendWeeks=8&manager=1&attention=1',
		);
		expect(parsed.viewMode).toBe('monthly');
		expect(parsed.searchQuery).toBe('PROJ');
		expect(parsed.onlyAttentionNeeded).toBe(true);
		expect(parsed.managerMode).toBe(true);
		expect(parsed.trendWeeks).toBe(8);
		expect(parsed.sortField).toBe('total');
		expect(parsed.sortDirection).toBe('desc');
		expect(parsed.selectedUser).toBe('Sarah Johnson');
		expect(parsed.yearMonth).toEqual({ year: 2025, monthZeroIndexed: 9 });
	});

	it('defaults viewMode to weekly when the param is absent or unknown', () => {
		expect(parseReportsURLParams('').viewMode).toBe('weekly');
		expect(parseReportsURLParams('?view=nonsense').viewMode).toBe('weekly');
	});

	it('clamps trendWeeks=999 to the max (12)', () => {
		expect(parseReportsURLParams('?trendWeeks=999').trendWeeks).toBe(12);
	});

	it('clamps trendWeeks=0 to the min (1)', () => {
		expect(parseReportsURLParams('?trendWeeks=0').trendWeeks).toBe(1);
	});

	it('falls back to the trendWeeks default when the value is non-numeric', () => {
		expect(parseReportsURLParams('?trendWeeks=banana').trendWeeks).toBe(4);
	});

	it('rejects year=99999 and month=42 (returns yearMonth=null)', () => {
		expect(parseReportsURLParams('?year=99999&month=10').yearMonth).toBeNull();
		expect(parseReportsURLParams('?year=2025&month=42').yearMonth).toBeNull();
		expect(parseReportsURLParams('?year=1999&month=10').yearMonth).toBeNull();
	});

	it('accepts valid year+month and zero-indexes the month', () => {
		expect(parseReportsURLParams('?year=2025&month=1').yearMonth).toEqual({
			year: 2025,
			monthZeroIndexed: 0,
		});
		expect(parseReportsURLParams('?year=2100&month=12').yearMonth).toEqual({
			year: 2100,
			monthZeroIndexed: 11,
		});
	});

	it('rejects malformed weekStart (returns null)', () => {
		expect(parseReportsURLParams('?weekStart=notadate').weekStart).toBeNull();
		expect(parseReportsURLParams('?weekStart=2025-13-40').weekStart).toBe(
			'2025-13-40',
		); // regex-only — semantic check is the store's job
	});

	it('accepts legacy `search` alias for the search query', () => {
		expect(parseReportsURLParams('?search=Mike').searchQuery).toBe('Mike');
	});

	it('returns null sortField/sortDirection for unknown values', () => {
		expect(
			parseReportsURLParams('?sort=nope&dir=sideways').sortField,
		).toBeNull();
		expect(
			parseReportsURLParams('?sort=nope&dir=sideways').sortDirection,
		).toBeNull();
	});

	it('treats `attention` and `manager` flags as exactly "1"', () => {
		expect(parseReportsURLParams('?attention=true').onlyAttentionNeeded).toBe(
			false,
		);
		expect(parseReportsURLParams('?manager=yes').managerMode).toBe(false);
	});
});

describe('getInitialViewModeFromURL (ADA-448)', () => {
	const originalSearch = window.location.search;

	afterEach(() => {
		window.history.replaceState({}, '', `/${originalSearch}`);
	});

	function setSearch(search: string) {
		window.history.replaceState({}, '', `/reports${search}`);
	}

	it('honors ?view=monthly on initial load', () => {
		setSearch('?view=monthly&year=2025&month=10');
		expect(getInitialViewModeFromURL()).toBe('monthly');
	});

	it('returns weekly when the param is absent', () => {
		setSearch('');
		expect(getInitialViewModeFromURL()).toBe('weekly');
	});

	it('returns weekly for any non-monthly value', () => {
		setSearch('?view=weekly');
		expect(getInitialViewModeFromURL()).toBe('weekly');
		setSearch('?view=nonsense');
		expect(getInitialViewModeFromURL()).toBe('weekly');
	});
});
