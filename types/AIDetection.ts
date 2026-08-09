/**
 * Types for the AI Detection API client (ADA-622).
 *
 * The AI Detection API analyses time-entry descriptions, issue keys, and
 * metadata for potential anomalies — mismatched descriptions, implausible
 * durations, duplicate entries, and other quality signals. Responses are
 * advisory; the user decides whether to act on them.
 */

/** Severity of a detected anomaly. */
export type AIDetectionSeverity = 'info' | 'warning' | 'critical';

/** Kind of anomaly the AI detected in a time entry. */
export type AIDetectionAnomalyKind =
	| 'description_mismatch'
	| 'implausible_duration'
	| 'duplicate_entry'
	| 'missing_description'
	| 'off_hours_entry'
	| 'overlapping_entry'
	| 'unusual_project'
	| 'unknown';

/** A single anomaly flagged in a time entry. */
export interface AIDetectionAnomaly {
	/** Machine-readable kind for programmatic filtering. */
	kind: AIDetectionAnomalyKind;
	/** Human-readable severity level. */
	severity: AIDetectionSeverity;
	/** Human-readable explanation of the anomaly. */
	detail: string;
	/** Optional suggested fix, if the API can recommend one. */
	suggestion?: string;
}

/** A suggested edit that would resolve one or more anomalies. */
export interface AIDetectionSuggestion {
	/** The field the suggestion applies to. */
	field: 'description' | 'timeSpentSeconds' | 'issueKey' | 'date';
	/** The suggested value. */
	value: string | number;
	/** Why this change is suggested. */
	reason: string;
}

/**
 * The time entry data sent to the AI Detection API for analysis.
 * Mirrors the shape of a worklog being entered or edited.
 */
export interface AIDetectionTimeEntry {
	/** Jira issue key, e.g. "PROJ-123". */
	issueKey: string;
	/** Work description provided by the user. */
	description: string;
	/** Time spent in seconds. */
	timeSpentSeconds: number;
	/** ISO date string (YYYY-MM-DD) for the entry. */
	date: string;
	/** Optional issue summary for cross-reference. */
	issueSummary?: string;
}

/** Request body sent to the AI Detection API. */
export interface AIDetectionRequest {
	/** The time entry to analyse. */
	timeEntry: AIDetectionTimeEntry;
	/**
	 * Optional context: entries already logged on the same day, so the
	 * API can detect overlaps / duplicates.
	 */
	siblingEntries?: AIDetectionTimeEntry[];
}

/** Response from the AI Detection API after analysing a time entry. */
export interface AIDetectionResponse {
	/** Whether any anomalies were detected. */
	detected: boolean;
	/** Anomalies found (empty array when `detected` is false). */
	anomalies: AIDetectionAnomaly[];
	/** Suggested edits to fix flagged issues. */
	suggestions: AIDetectionSuggestion[];
	/** Confidence score 0–1 for the overall analysis. */
	confidence: number;
}

/**
 * Error response shape from the AI Detection API.
 * Carries a machine-readable code so the client can differentiate
 * auth failures from rate limits from validation errors.
 */
export interface AIDetectionErrorResponse {
	error: {
		code: string;
		message: string;
	};
}
