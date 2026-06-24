import { create } from 'zustand';
import type { DaySummary, WorklogSuggestion } from '../../types/Suggestion';
import type { WorklogFetchProgress } from '../../types/worklogLoading';
import {
	addDaysToIsoDate,
	getMondayOfWeek,
	parseIsoDateLocal,
	toLocalDateString,
} from '../react/utils/date';
import {
	applyAdjustSuggestionTime,
	applyDismissSuggestion,
	applyFillDayGap,
	applyMarkMultipleLogged,
	applyMarkSuggestionLogged,
	applyUnmarkMultipleLogged,
	applyUnmarkSuggestionLogged,
} from '../services/dashboardActions';
import { useConfigStore } from './useConfigStore';

function getSunday(monday: string): string {
	return addDaysToIsoDate(monday, 6);
}

function shiftWeek(monday: string, weeks: number): string {
	const d = parseIsoDateLocal(monday);
	d.setDate(d.getDate() + weeks * 7);
	return toLocalDateString(d);
}

const todayMonday = getMondayOfWeek(new Date());

export interface WeekWorklogEntry {
	date: string;
	issueKey: string;
	issueSummary?: string;
	timeSpentSeconds: number;
	/** ISO timestamp the worklog was created in Jira (used for backdate detection). */
	created?: string;
	/** Worklog comment, used by classifiers to detect retroactive logging. */
	comment?: string;
	/**
	 * Set at fetch time from `classifyWorklog`. Backdated entries are
	 * excluded from day/week totals everywhere but the CSV export (per
	 * AGENTS.md ghost-reconciliation invariant).
	 */
	isBackdated?: boolean;
}

/**
 * A "ghost reconciliation" — a worklog whose intendedFor falls in the visible
 * week but whose loggedOn falls outside it. Surfaces on its intended day as a
 * non-counting placeholder, mirroring the Reports Monthly contract. Ghost
 * seconds NEVER contribute to a day's loggedSeconds or gapSeconds.
 */
export interface WeekGhostEntry {
	/** Same as intendedFor — the day the ghost should render on. */
	date: string;
	/** ISO date the worklog was actually logged (loggedOn from classifier). */
	loggedOn: string;
	/** ISO date the work was intended for. */
	intendedFor: string;
	/** Calendar days between intendedFor and loggedOn. */
	daysLate: number;
	issueKey?: string;
	issueSummary?: string;
	timeSpentSeconds: number;
}

interface DashboardState {
	weekStart: string;
	weekEnd: string;

	daySummaries: DaySummary[];
	weekWorklogs: WeekWorklogEntry[];
	weekGhosts: WeekGhostEntry[];

	isLoadingWorklogs: boolean;
	isLoadingJiraSuggestions: boolean;
	isLoadingGitlabSuggestions: boolean;
	isLoadingGithubSuggestions: boolean;
	isLoadingCalendarSuggestions: boolean;
	isLoadingRescueTime: boolean;

	worklogsError: string | null;
	jiraSuggestionsError: string | null;
	gitlabSuggestionsError: string | null;
	githubSuggestionsError: string | null;
	calendarSuggestionsError: string | null;
	rescueTimeError: string | null;

	lastFetchedAt: string | null;
	worklogsLoadingProgress: WorklogFetchProgress | null;
	setLastFetchedAt: (ts: string | null) => void;
	setWorklogsLoadingProgress: (progress: WorklogFetchProgress | null) => void;

	setWeek: (start: string) => void;
	goToPrevWeek: () => void;
	goToNextWeek: () => void;
	goToCurrentWeek: () => void;
	setDaySummaries: (summaries: DaySummary[]) => void;
	setWeekWorklogs: (worklogs: WeekWorklogEntry[]) => void;
	setWeekGhosts: (ghosts: WeekGhostEntry[]) => void;
	markSuggestionLogged: (suggestionId: string) => void;
	unmarkSuggestionLogged: (suggestionId: string) => void;
	markMultipleSuggestionsLogged: (ids: string[]) => void;
	unmarkMultipleSuggestionsLogged: (ids: string[]) => void;
	dismissSuggestion: (suggestionId: string) => void;
	mergePreviousWeekSuggestions: (suggestions: WorklogSuggestion[]) => void;
	adjustSuggestionTime: (suggestionId: string, deltaSeconds: number) => void;
	fillDayGap: (date: string) => void;

	setLoading: (
		source:
			| 'worklogs'
			| 'jira'
			| 'gitlab'
			| 'github'
			| 'calendar'
			| 'rescuetime',
		value: boolean,
	) => void;
	setError: (
		source:
			| 'worklogs'
			| 'jira'
			| 'gitlab'
			| 'github'
			| 'calendar'
			| 'rescuetime',
		value: string | null,
	) => void;
}

const loadingKeys = {
	worklogs: 'isLoadingWorklogs',
	jira: 'isLoadingJiraSuggestions',
	gitlab: 'isLoadingGitlabSuggestions',
	github: 'isLoadingGithubSuggestions',
	calendar: 'isLoadingCalendarSuggestions',
	rescuetime: 'isLoadingRescueTime',
} as const;

const errorKeys = {
	worklogs: 'worklogsError',
	jira: 'jiraSuggestionsError',
	gitlab: 'gitlabSuggestionsError',
	github: 'githubSuggestionsError',
	calendar: 'calendarSuggestionsError',
	rescuetime: 'rescueTimeError',
} as const;

export const useDashboardStore = create<DashboardState>((set, get) => ({
	weekStart: todayMonday,
	weekEnd: getSunday(todayMonday),

	daySummaries: [],
	weekWorklogs: [],
	weekGhosts: [],

	isLoadingWorklogs: false,
	isLoadingJiraSuggestions: false,
	isLoadingGitlabSuggestions: false,
	isLoadingGithubSuggestions: false,
	isLoadingCalendarSuggestions: false,
	isLoadingRescueTime: false,

	worklogsError: null,
	jiraSuggestionsError: null,
	gitlabSuggestionsError: null,
	githubSuggestionsError: null,
	calendarSuggestionsError: null,
	rescueTimeError: null,

	lastFetchedAt: null,
	worklogsLoadingProgress: null,
	setLastFetchedAt: (ts) => set({ lastFetchedAt: ts }),
	setWorklogsLoadingProgress: (progress) =>
		set({ worklogsLoadingProgress: progress }),

	setWeek: (start) => set({ weekStart: start, weekEnd: getSunday(start) }),

	goToPrevWeek: () => {
		const prev = shiftWeek(get().weekStart, -1);
		set({ weekStart: prev, weekEnd: getSunday(prev) });
	},

	goToNextWeek: () => {
		const next = shiftWeek(get().weekStart, 1);
		set({ weekStart: next, weekEnd: getSunday(next) });
	},

	goToCurrentWeek: () => {
		const monday = getMondayOfWeek(new Date());
		set({ weekStart: monday, weekEnd: getSunday(monday) });
	},

	setDaySummaries: (summaries) => set({ daySummaries: summaries }),

	setWeekWorklogs: (worklogs) => set({ weekWorklogs: worklogs }),

	setWeekGhosts: (ghosts) => set({ weekGhosts: ghosts }),

	markSuggestionLogged: (suggestionId) =>
		set((state) => ({
			daySummaries: applyMarkSuggestionLogged(state.daySummaries, suggestionId),
		})),

	unmarkSuggestionLogged: (suggestionId) =>
		set((state) => ({
			daySummaries: applyUnmarkSuggestionLogged(
				state.daySummaries,
				suggestionId,
			),
		})),

	markMultipleSuggestionsLogged: (ids) =>
		set((state) => ({
			daySummaries: applyMarkMultipleLogged(state.daySummaries, ids),
		})),

	unmarkMultipleSuggestionsLogged: (ids) =>
		set((state) => ({
			daySummaries: applyUnmarkMultipleLogged(state.daySummaries, ids),
		})),

	dismissSuggestion: (suggestionId) =>
		set((state) => ({
			daySummaries: applyDismissSuggestion(
				state.daySummaries,
				suggestionId,
				useConfigStore.getState().config.timeRounding,
			),
		})),

	mergePreviousWeekSuggestions: (suggestions) =>
		set((state) => ({
			daySummaries: state.daySummaries.map((day) => {
				// Find suggestions that target this day
				const newForDay = suggestions.filter((s) => s.date === day.date);
				if (newForDay.length === 0) return day;

				// Build a set of issue keys already present (logged or suggested)
				const existingKeys = new Set<string>();
				for (const s of day.suggestions) {
					existingKeys.add(s.issueKey);
				}

				// Only add suggestions for issues not already present
				const toAdd = newForDay.filter((s) => !existingKeys.has(s.issueKey));
				if (toAdd.length === 0) return day;

				return {
					...day,
					suggestions: [...day.suggestions, ...toAdd],
				};
			}),
		})),

	adjustSuggestionTime: (suggestionId, deltaSeconds) =>
		set((state) => ({
			daySummaries: applyAdjustSuggestionTime(
				state.daySummaries,
				suggestionId,
				deltaSeconds,
				useConfigStore.getState().config.timeRounding,
			),
		})),

	fillDayGap: (date) =>
		set((state) => ({
			daySummaries: applyFillDayGap(
				state.daySummaries,
				date,
				useConfigStore.getState().config.timeRounding,
			),
		})),

	setLoading: (source, value) =>
		set((state) =>
			state[loadingKeys[source]] === value
				? state
				: { [loadingKeys[source]]: value },
		),

	setError: (source, value) =>
		set((state) =>
			state[errorKeys[source]] === value
				? state
				: { [errorKeys[source]]: value },
		),
}));
