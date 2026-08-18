/**
 * Token rotation and expiration validation service.
 *
 * Provides structured expiry checking and rotation signals for every token
 * the app manages — Jira API token, GitLab PAT, RescueTime API key, and the
 * Supabase session JWT. Each source knows its own expiry semantics:
 *
 *   - **Supabase JWT** (access token): has a numeric `exp` claim we decode
 *     and check locally. The Supabase client auto-refreshes this, but the
 *     proxy bridge holds a snapshot; this service lets callers detect when
 *     it has expired between refreshes.
 *   - **Jira API token**: no client-detectable expiry (Atlassian tokens are
 *     long-lived and don't carry an `exp` claim). Validation is syntactic
 *     (non-empty, plausible length).
 *   - **GitLab PAT**: GitLab PATs carry an `expires_at` field in the
 *     personal_access_token API endpoint, but we don't hit that endpoint on
 *     every render. Syntactic validation + error-driven rotation signals.
 *   - **RescueTime API key**: opaque string, no expiry information available
 *     client-side. Syntactic validation only.
 *
 * Linear: ADA-630.
 */

import { ServiceError } from './serviceErrors';

// ── Types ────────────────────────────────────────────────────────────

export type TokenSource = 'jira' | 'gitlab' | 'rescueTime' | 'supabase';

export type TokenStatus =
	| 'valid'
	| 'expired'
	| 'expiring-soon'
	| 'missing'
	| 'invalid-format';

export interface TokenHealth {
	source: TokenSource;
	status: TokenStatus;
	/**
	 * When the token expires, in epoch milliseconds. `null` when the source
	 * doesn't carry expiry information or we couldn't decode it.
	 */
	expiresAtMs: number | null;
	/**
	 * Milliseconds until expiry. Negative values mean the token is already
	 * past its `exp`. `null` when the source has no expiry info.
	 */
	remainingMs: number | null;
	/**
	 * Human-readable message suitable for tooltip / inline banner.
	 */
	message: string;
}

export interface ValidateJwtResult {
	/** True when the token's `exp` has not passed within a clock-skew margin. */
	valid: boolean;
	/** The `exp` claim in epoch milliseconds, or null if absent / undecodeable. */
	expiresAtMs: number | null;
	/** Milliseconds until expiry (negative = already expired). */
	remainingMs: number | null;
}

// ── Constants ─────────────────────────────────────────────────────────

/** Clock-skew tolerance applied to all time-claim checks. */
const CLOCK_SKEW_MS = 60_000;

/**
 * Threshold for "expiring soon" warnings. When a token has fewer than this
 * many ms until expiry, the health status is `expiring-soon` instead of
 * `valid`.
 */
const EXPIRING_SOON_THRESHOLD_MS = 5 * 60_000; // 5 minutes

/**
 * Minimum length for a Jira API token. Atlassian API tokens are at least
 * 24 characters (typically ~64). This is a sanity check, not a guarantee.
 */
const MIN_JIRA_TOKEN_LENGTH = 24;

/**
 * Minimum length for a GitLab PAT. GitLab tokens are at least 20 characters
 * (personal access tokens prefixed with `glpat-` are 22+).
 */
const MIN_GITLAB_TOKEN_LENGTH = 20;

/**
 * Minimum length for a RescueTime API key. RescueTime keys are 32-character
 * hex strings.
 */
const MIN_RESCUETIME_KEY_LENGTH = 32;

// ── JWT helpers (client-side) ─────────────────────────────────────────

interface JwtPayload {
	exp?: number;
	[key: string]: unknown;
}

/**
 * Safely decode the *payload* of a JWT without verifying the signature.
 *
 * Supabase access tokens are asymmetric JWTs; we only read the `exp` claim
 * here, so signature verification is unnecessary — a forged `exp` is
 * self-defeating. Only returns `null` on malformed base64 / JSON, never
 * throws.
 */
function decodeJwtPayload(token: string): JwtPayload | null {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const payload = parts[1];
		if (!payload) return null;
		// Base64url → standard base64
		const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
		const padded = normalized.padEnd(
			normalized.length + ((4 - (normalized.length % 4)) % 4),
			'=',
		);
		const decoded = atob(padded);
		return JSON.parse(decoded) as JwtPayload;
	} catch {
		return null;
	}
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Decode and validate the `exp` claim of a JWT token.
 *
 * Returns structured information about expiry. This is a purely local
 * check — no network call, no signature verification. Use it to decide
 * whether a cached token snapshot is still likely valid before making a
 * request.
 *
 * @param token  The raw JWT string (three dot-separated base64 segments).
 * @param nowMs  Override the current time (ms since epoch) for testing.
 */
export function validateJwtExpiry(
	token: string,
	nowMs?: number,
): ValidateJwtResult {
	const now = nowMs ?? Date.now();

	const payload = decodeJwtPayload(token);
	if (!payload || typeof payload.exp !== 'number') {
		return {
			valid: false,
			expiresAtMs: null,
			remainingMs: null,
		};
	}

	const expiresAtMs = payload.exp * 1000;
	const remainingMs = expiresAtMs - now;

	// Clock-skew tolerance: treat tokens within CLOCK_SKEW_MS of expiry as
	// still valid to avoid unnecessary re-auth on small clock drift.
	const valid = remainingMs > -CLOCK_SKEW_MS;

	return { valid, expiresAtMs, remainingMs };
}

/**
 * Validate a token for a given source.
 *
 * Checks:
 *   - **Missing**: empty string → `missing`
 *   - **Format**: source-specific length/format sanity → `invalid-format`
 *   - **Expiry**: for `supabase`, decodes the JWT and checks `exp` →
 *     `expired` or `expiring-soon` or `valid`
 *   - **Other sources**: syntactic only (no client-side expiry available)
 *
 * @param source  The token source to validate against.
 * @param token   The raw token string (may be empty).
 * @param nowMs   Override the current time for testing (passed to JWT check).
 */
export function validateToken(
	source: TokenSource,
	token: string,
	nowMs?: number,
): TokenHealth {
	const missing: TokenHealth = {
		source,
		status: 'missing',
		expiresAtMs: null,
		remainingMs: null,
		message: tokenMessage(source, 'missing'),
	};

	if (!token) return missing;

	switch (source) {
		case 'jira': {
			if (token.length < MIN_JIRA_TOKEN_LENGTH) {
				return {
					source,
					status: 'invalid-format',
					expiresAtMs: null,
					remainingMs: null,
					message: tokenMessage(source, 'invalid-format'),
				};
			}
			// Jira tokens don't carry client-detectable expiry.
			return {
				source,
				status: 'valid',
				expiresAtMs: null,
				remainingMs: null,
				message: tokenMessage(source, 'valid'),
			};
		}

		case 'gitlab': {
			if (token.length < MIN_GITLAB_TOKEN_LENGTH) {
				return {
					source,
					status: 'invalid-format',
					expiresAtMs: null,
					remainingMs: null,
					message: tokenMessage(source, 'invalid-format'),
				};
			}
			// GitLab PATs can have an expiry stored server-side, but we don't
			// have a client-side way to read it without an API call.
			return {
				source,
				status: 'valid',
				expiresAtMs: null,
				remainingMs: null,
				message: tokenMessage(source, 'valid'),
			};
		}

		case 'rescueTime': {
			if (token.length < MIN_RESCUETIME_KEY_LENGTH) {
				return {
					source,
					status: 'invalid-format',
					expiresAtMs: null,
					remainingMs: null,
					message: tokenMessage(source, 'invalid-format'),
				};
			}
			return {
				source,
				status: 'valid',
				expiresAtMs: null,
				remainingMs: null,
				message: tokenMessage(source, 'valid'),
			};
		}

		case 'supabase': {
			const jwt = validateJwtExpiry(token, nowMs);
			if (!jwt.valid) {
				return {
					source,
					status: 'expired',
					expiresAtMs: jwt.expiresAtMs,
					remainingMs: jwt.remainingMs,
					message: tokenMessage(source, 'expired'),
				};
			}
			if (
				jwt.remainingMs !== null &&
				jwt.remainingMs < EXPIRING_SOON_THRESHOLD_MS
			) {
				return {
					source,
					status: 'expiring-soon',
					expiresAtMs: jwt.expiresAtMs,
					remainingMs: jwt.remainingMs,
					message: tokenMessage(source, 'expiring-soon'),
				};
			}
			return {
				source,
				status: 'valid',
				expiresAtMs: jwt.expiresAtMs,
				remainingMs: jwt.remainingMs,
				message: tokenMessage(source, 'valid'),
			};
		}
	}
}

/**
 * Convenience: validate all four token sources at once.
 *
 * @param tokens  An object mapping each source to its raw token string.
 *                Omitted or undefined sources are treated as missing.
 * @param nowMs   Override for testing (passed through to JWT check).
 */
export function validateAllTokens(
	tokens: Partial<Record<TokenSource, string>>,
	nowMs?: number,
): TokenHealth[] {
	return (Object.keys(tokenMessages) as TokenSource[]).map((source) =>
		validateToken(source, tokens[source] ?? '', nowMs),
	);
}

/**
 * Test whether a `ServiceError` indicates a token that needs rotation.
 *
 * Checks:
 *   - `invalid-token` kind (RescueTime 403, GitLab 401)
 *   - `unauthorized` kind (Jira / other 401s)
 *   - `entitlementCode` of `invalid_token` or `missing_token` (hosted-proxy
 *     Supabase session issues)
 *
 * Returns the relevant source when the error points to a token problem,
 * or `null` when the error is not token-related.
 */
export function errorIndicatesTokenRotation(
	error: unknown,
	sourceHint?: TokenSource,
): TokenSource | null {
	if (!(error instanceof ServiceError)) {
		// Legacy string errors: check for token-related substrings.
		const message =
			error instanceof Error ? error.message : String(error ?? '');
		const lower = message.toLowerCase();
		if (lower.includes('token') && lower.includes('invalid')) {
			return sourceHint ?? 'jira';
		}
		if (lower.includes('api key') && lower.includes('invalid')) {
			return sourceHint ?? 'rescueTime';
		}
		return null;
	}

	// Entitlement code from the hosted proxy — Supabase session issue.
	if (
		error.entitlementCode === 'invalid_token' ||
		error.entitlementCode === 'missing_token'
	) {
		return 'supabase';
	}

	// Service-level token rejection.
	switch (error.kind) {
		case 'invalid-token':
			// RescueTime returns 403 with invalid-token; GitLab 401 maps here.
			return sourceHint ?? error.source?.toLowerCase() === 'rescuetime'
				? 'rescueTime'
				: 'gitlab';
		case 'unauthorized':
			return sourceHint ?? 'jira';
		default:
			return null;
	}
}

// ── Messages ──────────────────────────────────────────────────────────

const tokenMessages: Record<TokenSource, Record<TokenStatus, string>> = {
	jira: {
		valid: 'Jira API token looks good.',
		expired: 'Jira API token needs updating.',
		'expiring-soon': 'Jira API token will expire soon.',
		missing: 'No Jira API token configured — add one in Settings.',
		'invalid-format':
			'Jira API token seems too short — double-check the full token in Settings.',
	},
	gitlab: {
		valid: 'GitLab token looks good.',
		expired: 'GitLab PAT has expired — generate a new one in GitLab.',
		'expiring-soon': 'GitLab PAT is close to expiring.',
		missing:
			'No GitLab personal access token configured — add one in Settings.',
		'invalid-format':
			'GitLab token seems too short — check that you copied the full PAT.',
	},
	rescueTime: {
		valid: 'RescueTime API key looks good.',
		expired: 'RescueTime API key is invalid — check your API key.',
		'expiring-soon': 'RescueTime API key will expire soon.',
		missing:
			'No RescueTime API key configured — add one in Settings to see activity suggestions.',
		'invalid-format':
			'RescueTime API key seems too short — it should be a 32-character hex string.',
	},
	supabase: {
		valid: 'Session token is valid.',
		expired:
			'Your session has expired — sign in again to use the hosted proxy.',
		'expiring-soon':
			'Your session expires soon — it will refresh automatically.',
		missing:
			'You are not signed in. Sign in to use hosted-proxy features.',
		'invalid-format':
			'Session token is malformed — sign in again to refresh it.',
	},
};

function tokenMessage(
	source: TokenSource,
	status: TokenStatus,
): string {
	return tokenMessages[source]?.[status] ?? 'Unknown token status.';
}
