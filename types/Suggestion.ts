import type { AbsenceKind } from './absence';

export interface WorklogSuggestion {
	id: string;
	source:
		| 'jira-activity'
		| 'gitlab'
		| 'github'
		| 'calendar'
		| 'rescuetime'
		| 'favorite'
		| 'template'
		| 'previous-week';
	issueKey: string;
	issueSummary?: string;
	date: string;
	suggestedTimeSpent: string;
	suggestedSeconds: number;
	confidence: 'high' | 'medium' | 'low';
	reason: string;
	logged: boolean;
	/** Calendar event title — present on unmapped calendar suggestions */
	calendarEventTitle?: string;
}

export interface RescueTimeActivity {
	name: string;
	category: string;
	seconds: number;
	productivity: number;
}

export interface RescueTimeDaySummary {
	productiveSeconds: number;
	topActivities: RescueTimeActivity[];
}

/**
 * A real (already-logged, non-backdated) Jira worklog placed on its day.
 * Surfaced per-day so the user can act on it (e.g. clone it elsewhere) — the
 * Dashboard otherwise only keeps the aggregate `loggedSeconds`.
 */
export interface LoggedWorklog {
	worklogId: string;
	issueKey: string;
	issueSummary?: string;
	timeSpentSeconds: number;
}

export interface DaySummary {
	date: string;
	dayOfWeek: number;
	isWeekend: boolean;
	loggedSeconds: number;
	targetSeconds: number;
	gapSeconds: number;
	absenceKind?: AbsenceKind;
	suggestions: WorklogSuggestion[];
	/** Non-backdated worklogs logged on this day (drives the "Clone to…" UI). */
	loggedWorklogs: LoggedWorklog[];
	rescueTime?: RescueTimeDaySummary;
}

export interface WeekRange {
	start: string;
	end: string;
}
