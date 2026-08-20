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
	/**
	 * When the underlying activity happened, local `YYYY-MM-DDTHH:mm:ss`, when
	 * the source knows it — a calendar event's start, a commit's timestamp. The
	 * layout places these at their real time rather than guessing a slot.
	 */
	activityAt?: string;
	/**
	 * The `started` this suggestion was actually written to Jira with, recorded
	 * when it is marked logged. The week is not refetched after a write, so
	 * without this the suggestion leaves the layout's input without ever
	 * appearing in `loggedWorklogs` — its time vanishes and the next suggestion
	 * is placed straight on top of it. Cleared when the log is undone.
	 */
	loggedStartedAt?: string;
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
	/**
	 * Hours (0-23, local) that saw activity. The shape of the day: where it
	 * started, and where the breaks were. Used to place suggestions in sequence
	 * instead of stacking them all on a fixed hour.
	 */
	activeHours: number[];
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
	/**
	 * When this worklog starts. Present so newly logged suggestions can be
	 * placed around already-logged time instead of on top of it.
	 */
	startedAt?: string;
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
