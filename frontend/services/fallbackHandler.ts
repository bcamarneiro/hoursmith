/**
 * Fallback logic handler for Hoursmith.
 *
 * Centralizes the definition of error conditions and determines the current
 * fallback mode when one or more upstream services fail. Components read the
 * returned `FallbackState` to decide which UI affordances to surface
 * (e.g. manual entry, cached data, retry prompts).
 *
 * The handler is a pure function — callers pass in the error state from
 * stores and receive a deterministic evaluation of the current mode plus
 * available actions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Operating mode of the application.
 *
 * - `normal` — All core services have resolved successfully (or haven't
 *   reported errors yet). The dashboard shows live data and suggestions.
 * - `degraded` — One or more non-critical suggestion sources (GitLab,
 *   calendar, RescueTime) failed, but Jira worklogs are still available.
 *   The dashboard renders correctly but with fewer suggestions.
 * - `manual-entry` — The Jira worklog fetch failed. Users cannot see or
 *   rely on live worklog data. The UI should offer manual-entry
 *   affordances (favorites, templates, copy-previous-week) so the user
 *   can still plan and estimate their week. Logged state is ephemeral
 *   until Jira recovers.
 * - `offline` — The Jira connection cannot be established at all
 *   (e.g. invalid token, host unreachable, CORS proxy down). No Jira-
 *   sourced data is available and the user must work fully offline.
 */
export type FallbackMode = 'normal' | 'degraded' | 'manual-entry' | 'offline';

/**
 * How severely a service failure impacts the user experience.
 *
 * - `non-blocking` — Suggestions only. The dashboard works fine without it.
 * - `fallback-required` — Core data source (worklogs) failed; the app must
 *   fall back to manual-entry mode.
 * - `blocking` — Connection-level failure (auth, network). The user cannot
 *   interact with Jira at all until the issue is resolved.
 */
export type FailureSeverity = 'non-blocking' | 'fallback-required' | 'blocking';

/**
 * Identifier for an upstream service source. Matches the `source` parameter
 * used by `useDashboardStore.setError()`.
 */
export type ServiceSource =
	| 'worklogs'
	| 'jira'
	| 'gitlab'
	| 'calendar'
	| 'rescuetime';

/**
 * Snapshot of a single service's error state.
 */
export interface ServiceErrorState {
	/** The service identifier. */
	source: ServiceSource;
	/** Whether this source currently reports an error. */
	hasError: boolean;
	/** The raw error message from the store, if any. */
	errorMessage: string | null;
}

/**
 * Evaluation of one service after severity classification.
 */
export interface ServiceStatus {
	source: ServiceSource;
	hasError: boolean;
	errorMessage: string | null;
	severity: FailureSeverity;
	/** Human-readable description of the fallback behaviour for this service. */
	fallbackBehavior: string;
}

/**
 * Full fallback state returned by `evaluateFallbackState()`.
 */
export interface FallbackState {
	/** The overall operating mode. */
	mode: FallbackMode;
	/** Per-service evaluation. */
	services: ServiceStatus[];
	/**
	 * Which high-level actions are available to the user in the current mode.
	 * Components gate UI affordances (buttons, sections, keyboard shortcuts)
	 * on these flags so every surface stays consistent.
	 */
	availableActions: {
		/** View suggestion cards from non-worklog sources. */
		viewSuggestions: boolean;
		/** Add a manual worklog entry (favorite, template, or free-form). */
		addManualEntry: boolean;
		/** Use the Favorites manager. */
		useFavorites: boolean;
		/** Use the Templates manager. */
		useTemplates: boolean;
		/** Export week/month/team CSVs (still works with cached data). */
		exportData: boolean;
		/** Copy suggestions from the previous week. */
		copyPreviousWeek: boolean;
	};
}

// ---------------------------------------------------------------------------
// Default available actions for each mode
// ---------------------------------------------------------------------------

const ACTION_SETS: Record<FallbackMode, FallbackState['availableActions']> = {
	normal: {
		viewSuggestions: true,
		addManualEntry: true,
		useFavorites: true,
		useTemplates: true,
		exportData: true,
		copyPreviousWeek: true,
	},
	degraded: {
		// Some suggestion sources are down, but Jira worklogs are OK.
		// Manual entry is still available as a complement, not a necessity.
		viewSuggestions: true,
		addManualEntry: true,
		useFavorites: true,
		useTemplates: true,
		exportData: true,
		copyPreviousWeek: true,
	},
	'manual-entry': {
		// Jira worklogs failed — the primary data is unavailable.
		// Allow planning via manual entry and templates. Suggestions from
		// non-Jira sources may still be useful.
		viewSuggestions: true,
		addManualEntry: true,
		useFavorites: true,
		useTemplates: true,
		exportData: false, // No live worklogs to export
		copyPreviousWeek: true, // Works from cached data
	},
	offline: {
		// No Jira connection at all. The user can still plan their week
		// manually so they have a reference when Jira comes back.
		viewSuggestions: false,
		addManualEntry: true,
		useFavorites: true,
		useTemplates: true,
		exportData: false,
		copyPreviousWeek: false,
	},
};

// ---------------------------------------------------------------------------
// Severity classification
// ---------------------------------------------------------------------------

/**
 * Known error-message substrings that indicate a connection-level (blocking)
 * failure rather than a transient fetch error.
 *
 * These are checked case-insensitively against the raw error message string.
 */
const BLOCKING_PATTERNS = [
	'invalid token',
	'unauthorized',
	'forbidden',
	'networkerror',
	'failed to fetch',
	'cors',
	'proxy',
	'session expired',
	'connection refused',
];

/**
 * Classify a single service error into a severity level.
 *
 * - `blocking` when the error message matches a known connection/auth pattern.
 * - `fallback-required` for the core `worklogs` source (the sink for
 *   `fetchMonthWorklogs` failures).
 * - `non-blocking` for everything else (suggestion sources, transient errors).
 */
function classifySeverity(
	state: ServiceErrorState,
): FailureSeverity {
	if (!state.hasError || !state.errorMessage) return 'non-blocking';

	const msg = state.errorMessage.toLowerCase();

	for (const pattern of BLOCKING_PATTERNS) {
		if (msg.includes(pattern)) return 'blocking';
	}

	// Core worklog source that failed with a non-blocking error class
	// still forces manual-entry mode — the user can't trust the data.
	if (state.source === 'worklogs') return 'fallback-required';

	return 'non-blocking';
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const FALLBACK_BEHAVIOR: Record<ServiceSource, string> = {
	worklogs: 'Live worklog data is unavailable. Use manual entry to plan your week.',
	jira: 'Jira activity suggestions are unavailable. Other suggestion sources may still work.',
	gitlab: 'GitLab suggestions are unavailable.',
	calendar: 'Calendar suggestions are unavailable.',
	rescuetime: 'RescueTime productivity data is unavailable.',
};

/**
 * Evaluate the current fallback state from per-service error snapshots.
 *
 * Callers read error/lack-of-error signals from stores and pass them in.
 * The function is pure — no store reads, no side effects.
 *
 * @param services - One entry per tracked source. Omit sources that are
 *   not configured (no token set, etc.) — only pass what is active.
 * @returns A `FallbackState` suitable for gating UI affordances.
 */
export function evaluateFallbackState(
	services: ServiceErrorState[],
): FallbackState {
	const serviceStatuses: ServiceStatus[] = services.map((s) => {
		const severity = classifySeverity(s);
		return {
			source: s.source,
			hasError: s.hasError,
			errorMessage: s.errorMessage,
			severity,
			fallbackBehavior: FALLBACK_BEHAVIOR[s.source],
		};
	});

	// Determine the overall mode — pick the most severe across all services
	// that actually have an active error. Services with `hasError: false`
	// always report `non-blocking` severity from classifySeverity's early
	// return, so we must gate on hasError to avoid flipping to degraded
	// when no service is actually failing.
	let mode: FallbackMode = 'normal';

	for (const s of serviceStatuses) {
		if (!s.hasError) continue;
		if (s.severity === 'blocking') {
			mode = 'offline';
		} else if (s.severity === 'fallback-required' && mode !== 'offline') {
			mode = 'manual-entry';
		} else if (s.severity === 'non-blocking' && mode === 'normal') {
			mode = 'degraded';
		}
	}

	return {
		mode,
		services: serviceStatuses,
		availableActions: { ...ACTION_SETS[mode] },
	};
}

/**
 * Convenience helper: derive a `FallbackState` directly from the dashboard
 * store's shape (the five error fields and their loading counterparts).
 *
 * Use this to avoid repeating the mapping boilerplate in every component.
 */
export interface DashboardErrorSnapshot {
	worklogsError: string | null;
	jiraSuggestionsError: string | null;
	gitlabSuggestionsError: string | null;
	calendarSuggestionsError: string | null;
	rescueTimeError: string | null;
}

/**
 * Build a `FallbackState` from the dashboard store's raw error fields.
 *
 * @param errors - Snapshot of the five error strings from `useDashboardStore`.
 * @returns A fully-evaluated fallback state.
 */
export function evaluateDashboardFallback(
	errors: DashboardErrorSnapshot,
): FallbackState {
	return evaluateFallbackState([
		{
			source: 'worklogs',
			hasError: errors.worklogsError !== null,
			errorMessage: errors.worklogsError,
		},
		{
			source: 'jira',
			hasError: errors.jiraSuggestionsError !== null,
			errorMessage: errors.jiraSuggestionsError,
		},
		{
			source: 'gitlab',
			hasError: errors.gitlabSuggestionsError !== null,
			errorMessage: errors.gitlabSuggestionsError,
		},
		{
			source: 'calendar',
			hasError: errors.calendarSuggestionsError !== null,
			errorMessage: errors.calendarSuggestionsError,
		},
		{
			source: 'rescuetime',
			hasError: errors.rescueTimeError !== null,
			errorMessage: errors.rescueTimeError,
		},
	]);
}
