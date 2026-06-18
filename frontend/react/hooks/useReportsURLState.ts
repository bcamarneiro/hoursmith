import { useCallback, useEffect } from 'react';
import { useTeamStore } from '../../stores/useTeamStore';
import { useTimesheetStore } from '../../stores/useTimesheetStore';

export type ReportsViewMode = 'monthly' | 'weekly';
export type ReportsSortField = 'name' | 'total' | 'gap';
export type ReportsSortDirection = 'asc' | 'desc';

type Props = {
	viewMode: ReportsViewMode;
	setViewMode: (value: ReportsViewMode) => void;
	searchQuery: string;
	setSearchQuery: (value: string) => void;
	onlyAttentionNeeded: boolean;
	setOnlyAttentionNeeded: (value: boolean) => void;
	managerMode: boolean;
	setManagerMode: (value: boolean) => void;
	trendWeeks: number;
	setTrendWeeks: (value: number) => void;
	sortField: ReportsSortField;
	setSortField: (value: ReportsSortField) => void;
	sortDirection: ReportsSortDirection;
	setSortDirection: (value: ReportsSortDirection) => void;
};

const TREND_WEEKS_MIN = 1;
const TREND_WEEKS_MAX = 12;
const TREND_WEEKS_DEFAULT = 4;
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

function isValidWeekStart(value: string | null): value is string {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function clampTrendWeeks(value: number): number {
	if (!Number.isFinite(value)) return TREND_WEEKS_DEFAULT;
	const rounded = Math.trunc(value);
	if (rounded < TREND_WEEKS_MIN) return TREND_WEEKS_MIN;
	if (rounded > TREND_WEEKS_MAX) return TREND_WEEKS_MAX;
	return rounded;
}

export interface ParsedReportsURLParams {
	viewMode: ReportsViewMode;
	searchQuery: string;
	onlyAttentionNeeded: boolean;
	managerMode: boolean;
	trendWeeks: number;
	sortField: ReportsSortField | null;
	sortDirection: ReportsSortDirection | null;
	selectedUser: string;
	/** Present only when both year and month are within sane bounds. */
	yearMonth: { year: number; monthZeroIndexed: number } | null;
	weekStart: string | null;
}

/**
 * Pure parser for Reports URL query params. Exposed for tests; the hook
 * uses it on every popstate / mount. All clamping/validation lives here
 * so a single set of edge cases (year=99999, trendWeeks=999, etc.) is
 * pinned in one place.
 */
export function parseReportsURLParams(search: string): ParsedReportsURLParams {
	const params = new URLSearchParams(search);

	const viewParam = params.get('view');
	const viewMode: ReportsViewMode =
		viewParam === 'monthly' ? 'monthly' : 'weekly';

	const rawQuery = params.get('q') ?? params.get('search');
	const searchQuery = rawQuery?.trim() || '';

	const onlyAttentionNeeded = params.get('attention') === '1';
	const managerMode = params.get('manager') === '1';

	const trendWeeksRaw = params.get('trendWeeks');
	const trendWeeks =
		trendWeeksRaw === null
			? TREND_WEEKS_DEFAULT
			: clampTrendWeeks(Number.parseInt(trendWeeksRaw, 10));

	const sortFieldParam = params.get('sort');
	const sortField: ReportsSortField | null =
		sortFieldParam === 'name' ||
		sortFieldParam === 'total' ||
		sortFieldParam === 'gap'
			? sortFieldParam
			: null;

	const sortDirParam = params.get('dir');
	const sortDirection: ReportsSortDirection | null =
		sortDirParam === 'asc' || sortDirParam === 'desc' ? sortDirParam : null;

	const selectedUser = params.get('user')?.trim() || '';

	const yearParam = Number.parseInt(params.get('year') || '', 10);
	const monthParam = Number.parseInt(params.get('month') || '', 10);
	const yearMonth =
		Number.isFinite(yearParam) &&
		yearParam >= YEAR_MIN &&
		yearParam <= YEAR_MAX &&
		Number.isFinite(monthParam) &&
		monthParam >= 1 &&
		monthParam <= 12
			? { year: yearParam, monthZeroIndexed: monthParam - 1 }
			: null;

	const weekStartRaw = params.get('weekStart');
	const weekStart = isValidWeekStart(weekStartRaw) ? weekStartRaw : null;

	return {
		viewMode,
		searchQuery,
		onlyAttentionNeeded,
		managerMode,
		trendWeeks,
		sortField,
		sortDirection,
		selectedUser,
		yearMonth,
		weekStart,
	};
}

/**
 * Read the user= query param from the current location synchronously.
 * Exported so callers can seed initial state before the read effect runs.
 */
export function getInitialSelectedUserFromURL(): string {
	if (typeof window === 'undefined') return '';
	const params = new URLSearchParams(window.location.search);
	return params.get('user')?.trim() || '';
}

/**
 * Read the view= query param synchronously so the page can initialize its
 * view-mode state from the URL on first render. Without this, the state
 * defaults to 'weekly' and the URL-write effect can normalize a
 * `?view=monthly` deep-link back to weekly before the read effect applies it
 * (ADA-448). Defaults to 'weekly' for any missing/invalid value.
 */
export function getInitialViewModeFromURL(): ReportsViewMode {
	if (typeof window === 'undefined') return 'weekly';
	const params = new URLSearchParams(window.location.search);
	return params.get('view') === 'monthly' ? 'monthly' : 'weekly';
}

export function useReportsURLState({
	viewMode,
	setViewMode,
	searchQuery,
	setSearchQuery,
	onlyAttentionNeeded,
	setOnlyAttentionNeeded,
	managerMode,
	setManagerMode,
	trendWeeks,
	setTrendWeeks,
	sortField,
	setSortField,
	sortDirection,
	setSortDirection,
}: Props) {
	const currentYear = useTimesheetStore((state) => state.currentYear);
	const currentMonth = useTimesheetStore((state) => state.currentMonth);
	const selectedUser = useTimesheetStore((state) => state.selectedUser);
	const setCurrentMonth = useTimesheetStore((state) => state.setCurrentMonth);
	const setSelectedUser = useTimesheetStore((state) => state.setSelectedUser);
	const weekStart = useTeamStore((state) => state.weekStart);
	const setWeek = useTeamStore((state) => state.setWeek);

	const syncFromLocation = useCallback(() => {
		const parsed = parseReportsURLParams(window.location.search);
		setViewMode(parsed.viewMode);
		setSearchQuery(parsed.searchQuery);
		setOnlyAttentionNeeded(parsed.onlyAttentionNeeded);
		setManagerMode(parsed.managerMode);
		setTrendWeeks(parsed.trendWeeks);
		if (parsed.sortField) setSortField(parsed.sortField);
		if (parsed.sortDirection) setSortDirection(parsed.sortDirection);
		setSelectedUser(parsed.selectedUser);
		if (parsed.yearMonth) {
			setCurrentMonth(parsed.yearMonth.year, parsed.yearMonth.monthZeroIndexed);
		}
		if (parsed.weekStart) setWeek(parsed.weekStart);
	}, [
		setCurrentMonth,
		setManagerMode,
		setOnlyAttentionNeeded,
		setSearchQuery,
		setSelectedUser,
		setSortDirection,
		setSortField,
		setTrendWeeks,
		setViewMode,
		setWeek,
	]);

	useEffect(() => {
		syncFromLocation();
		const handlePopstate = () => syncFromLocation();
		window.addEventListener('popstate', handlePopstate);
		return () => window.removeEventListener('popstate', handlePopstate);
	}, [syncFromLocation]);

	useEffect(() => {
		const url = new URL(window.location.href);
		url.searchParams.set('view', viewMode);
		url.searchParams.set('year', String(currentYear));
		url.searchParams.set('month', String(currentMonth + 1));
		url.searchParams.set('weekStart', weekStart);
		url.searchParams.set('sort', sortField);
		url.searchParams.set('dir', sortDirection);

		if (selectedUser) {
			url.searchParams.set('user', selectedUser);
		} else {
			url.searchParams.delete('user');
		}

		// Always remove the legacy `search` key when writing the canonical `q`.
		url.searchParams.delete('search');
		const trimmedQuery = searchQuery.trim();
		if (trimmedQuery) {
			url.searchParams.set('q', trimmedQuery);
		} else {
			url.searchParams.delete('q');
		}

		if (onlyAttentionNeeded) {
			url.searchParams.set('attention', '1');
		} else {
			url.searchParams.delete('attention');
		}

		if (managerMode) {
			url.searchParams.set('manager', '1');
		} else {
			url.searchParams.delete('manager');
		}

		if (trendWeeks !== TREND_WEEKS_DEFAULT) {
			url.searchParams.set('trendWeeks', String(clampTrendWeeks(trendWeeks)));
		} else {
			url.searchParams.delete('trendWeeks');
		}

		window.history.replaceState({}, '', url.toString());
	}, [
		viewMode,
		currentYear,
		currentMonth,
		selectedUser,
		searchQuery,
		onlyAttentionNeeded,
		managerMode,
		trendWeeks,
		sortField,
		sortDirection,
		weekStart,
	]);
}
