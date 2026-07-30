/**
 * Types for the Identity Matching Service — profile identity resolution
 * across disparate data sources (Jira, GitLab, calendar feeds, etc.).
 */

/** Normalised display-name components after tokenisation. */
export type NameTokens = string[];

/**
 * A user identity extracted from one data source.
 * Fields are optional — a GitLab activity event may carry only a displayName,
 * while a Jira user object typically has all three.
 */
export interface IdentityProfile {
	/** Primary email address (lowercased). */
	email?: string;
	/** Human-readable display name (e.g. "Bruno Camarneiro"). */
	displayName?: string;
	/** Opaque account / user id from the source system. */
	accountId?: string;
	/** Canonical source label (e.g. "jira", "gitlab", "calendar"). */
	source: string;
}

/** The outcome of comparing two identity profiles. */
export interface MatchResult {
	/** Whether the profiles are considered the same person. */
	match: boolean;
	/** Confidence score in [0, 1] — 1.0 = certain. */
	confidence: number;
	/** The matching method that produced the highest score. */
	method: MatchMethod;
	/** Which fields contributed positive evidence. */
	matchedFields: string[];
	/** Per-field similarity scores for downstream inspection. */
	fieldScores: Record<string, number>;
}

export type MatchMethod =
	| 'email-exact'
	| 'account-id-exact'
	| 'email-fuzzy'
	| 'name-exact'
	| 'name-fuzzy'
	| 'name-subset'
	| 'no-match';

/** Result of resolving one profile against a pool of candidates. */
export interface IdentityResolutionResult {
	/** Ranked candidates with their scores. */
	candidates: Array<{ profile: IdentityProfile; score: number }>;
	/** The best-matching profile, or null if no candidate scores > 0. */
	best: IdentityProfile | null;
	/** Overall confidence in the best match. */
	confidence: number;
}

/** Validation error codes. */
export type ValidationCode =
	| 'missing-email'
	| 'invalid-email'
	| 'missing-display-name'
	| 'missing-source'
	| 'empty-profile';

export interface ValidationError {
	code: ValidationCode;
	field: string;
	message: string;
}
