/**
 * Auth Token Service for Hoursmith Premium (ADA-692).
 *
 * The service facade that ties encrypted at-rest persistence (ADA-648
 * `tokenStorage.ts`) to the encryption wrapper (ADA-677 `aesCrypto.ts`) and
 * adds the decision logic server-side integrations need:
 *
 *   - Storage: `saveToken` / `getDecryptedToken` / `revokeToken` /
 *     `deleteToken`. Plaintext tokens are encrypted before they reach the
 *     database and only ever decrypted in memory at read time.
 *   - Silent refresh: `tokenExpiry` + `shouldRefresh` (+ `shouldSilentlyRefresh`)
 *     decide when a stored token needs refreshing, tolerating up to
 *     `skewMs` of clock drift and triggering `refreshLeadMs` before hard
 *     expiry. The actual OAuth exchange lives in `oauthExchange.ts`
 *     (ADA-681); this service supplies the trigger.
 *   - Validation: `validateToken` / `listStatuses` report per-token health
 *     without throwing — one malformed or unreadable token never takes down
 *     the status surface (account page, health endpoint) for every other
 *     provider. That is the "no global UI impact" contract: failures are
 *     isolated per token, and secrets are never included in status payloads.
 *
 * Bundle format: the plaintext JSON stored (encrypted) inside
 * `user_tokens.encrypted_value`. Field names mirror `TokenBundle` in
 * `oauthExchange.ts` (branch `aragorn/ada-681`) so both modules can read the
 * same rows once that branch merges; `refreshToken` is nullable here because
 * PAT-only providers (rescuetime, toggl, harvest, clockify) have no refresh
 * grant. Keep the two shapes in sync.
 *
 * Dependency-free (fetch only) so this stays edge-runtime compatible,
 * mirroring `tokenStorage.ts` and `polarClient.ts`. All collaborators are
 * injectable so unit tests run offline.
 *
 * Linear: ADA-692.
 */

import { makeAesCipher } from './aesCrypto.js';
import {
	makeTokenStorage,
	type TokenProvider,
	type TokenStorage,
	type TokenStorageEnv,
	type UserToken,
} from './tokenStorage.js';

// ---------------------------------------------------------------------------
// Bundle shape (the plaintext stored encrypted in user_tokens)
// ---------------------------------------------------------------------------

export const AUTH_TOKEN_BUNDLE_VERSION = 1;

export interface AuthTokenBundle {
	version: typeof AUTH_TOKEN_BUNDLE_VERSION;
	provider: TokenProvider;
	accessToken: string;
	/** Null for PAT-only providers that have no refresh grant. */
	refreshToken: string | null;
	/** ISO timestamp when the access token expires (null if unknown). */
	expiresAt: string | null;
	tokenType: string | null;
	scope: string | null;
}

/** Plaintext inputs accepted by `saveToken`. */
export interface SaveTokenInput {
	accessToken: string;
	refreshToken?: string | null;
	/** ISO timestamp when the access token expires (optional). */
	expiresAt?: string | null;
	tokenType?: string | null;
	scope?: string | null;
	/** Optional human-readable label stored on the row. */
	label?: string;
}

export function serializeBundle(bundle: AuthTokenBundle): string {
	return JSON.stringify(bundle);
}

/**
 * Parse + validate a stored bundle. Throws on malformed payloads or an
 * unknown version — consumers fail closed rather than trusting garbage.
 */
export function parseBundle(payload: string): AuthTokenBundle {
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		throw new AuthTokenError(
			'token_malformed',
			'authTokenService.parseBundle: payload is not valid JSON.',
		);
	}
	if (!raw || typeof raw !== 'object') {
		throw new AuthTokenError(
			'token_malformed',
			'authTokenService.parseBundle: payload must be an object.',
		);
	}
	const bundle = raw as Partial<AuthTokenBundle>;
	if (bundle.version !== AUTH_TOKEN_BUNDLE_VERSION) {
		throw new AuthTokenError(
			'token_malformed',
			`authTokenService.parseBundle: unsupported bundle version ${String(bundle.version)}.`,
		);
	}
	if (
		typeof bundle.provider !== 'string' ||
		bundle.provider.length === 0 ||
		typeof bundle.accessToken !== 'string' ||
		bundle.accessToken.length === 0
	) {
		throw new AuthTokenError(
			'token_malformed',
			'authTokenService.parseBundle: payload is malformed.',
		);
	}
	if (bundle.refreshToken !== null && typeof bundle.refreshToken !== 'string') {
		throw new AuthTokenError(
			'token_malformed',
			'authTokenService.parseBundle: refreshToken must be a string or null.',
		);
	}
	if (
		bundle.expiresAt !== null &&
		bundle.expiresAt !== undefined &&
		!isValidIsoTimestamp(bundle.expiresAt)
	) {
		throw new AuthTokenError(
			'token_malformed',
			'authTokenService.parseBundle: expiresAt must be an ISO timestamp or null.',
		);
	}
	return {
		version: AUTH_TOKEN_BUNDLE_VERSION,
		provider: bundle.provider,
		accessToken: bundle.accessToken,
		refreshToken: bundle.refreshToken ?? null,
		expiresAt: bundle.expiresAt ?? null,
		tokenType: bundle.tokenType ?? null,
		scope: bundle.scope ?? null,
	};
}

// ---------------------------------------------------------------------------
// Clock-skew tolerant expiry + silent-refresh triggers
// ---------------------------------------------------------------------------

export interface ExpiryOptions {
	/**
	 * Clock-skew tolerance in ms applied to the expiry boundary. A token that
	 * expired up to `skewMs` ago is still reported as `expiring` (refresh
	 * window) instead of `expired`, so a slightly-ahead local clock never
	 * forces a hard failure on a token the provider still accepts.
	 * Defaults to 60_000 (1 minute).
	 */
	skewMs?: number;
	/**
	 * Lead time in ms before expiry at which a refresh should trigger.
	 * Defaults to 300_000 (5 minutes).
	 */
	refreshLeadMs?: number;
}

export const DEFAULT_CLOCK_SKEW_MS = 60_000;
export const DEFAULT_REFRESH_LEAD_MS = 5 * 60_000;

export type TokenExpiryState = 'fresh' | 'expiring' | 'expired' | 'unknown';

export interface TokenExpiryInfo {
	state: TokenExpiryState;
	/** Epoch ms of the token's expiry, or null when unknown. */
	expiresAtMs: number | null;
	/** Milliseconds until expiry (negative = already past). Null when unknown. */
	remainingMs: number | null;
}

/**
 * Classify a token's expiry state relative to `nowMs`.
 *
 *   - `unknown`   → the bundle carries no `expiresAt` (e.g. PATs).
 *   - `fresh`     → more than `refreshLeadMs` of life left.
 *   - `expiring`  → inside the refresh window OR expired by no more than
 *                   `skewMs` (clock drift — the token may still be valid).
 *   - `expired`   → hard-expired beyond the skew grace; treat as unusable.
 *
 * Pure function; never throws. `expiresAt` is assumed to be either null or a
 * valid ISO timestamp (guaranteed by `parseBundle`).
 */
export function tokenExpiry(
	bundle: Pick<AuthTokenBundle, 'expiresAt'>,
	nowMs: number,
	options: ExpiryOptions = {},
): TokenExpiryInfo {
	const skewMs = options.skewMs ?? DEFAULT_CLOCK_SKEW_MS;
	const leadMs = options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS;
	if (bundle.expiresAt === null) {
		return { state: 'unknown', expiresAtMs: null, remainingMs: null };
	}
	const expiresAtMs = Date.parse(bundle.expiresAt);
	if (!Number.isFinite(expiresAtMs)) {
		return { state: 'unknown', expiresAtMs: null, remainingMs: null };
	}
	const remainingMs = expiresAtMs - nowMs;
	let state: TokenExpiryState;
	if (remainingMs > leadMs) {
		state = 'fresh';
	} else if (remainingMs >= -skewMs) {
		// Within the lead window, or just past expiry inside the skew grace —
		// either way this is the silent-refresh trigger zone.
		state = 'expiring';
	} else {
		state = 'expired';
	}
	return { state, expiresAtMs, remainingMs };
}

/**
 * True when a token with a refresh grant should be silently refreshed right
 * now: it is in the `expiring` zone (lead window or skew grace). A hard-
 * expired token returns false — that path needs explicit re-auth, not a
 * background refresh.
 */
export function shouldRefresh(
	bundle: Pick<AuthTokenBundle, 'expiresAt'>,
	nowMs: number,
	options: ExpiryOptions = {},
): boolean {
	return tokenExpiry(bundle, nowMs, options).state === 'expiring';
}

/** True when the bundle carries a refresh token (i.e. refresh is possible). */
export function canSilentlyRefresh(
	bundle: Pick<AuthTokenBundle, 'refreshToken'>,
): boolean {
	return (
		bundle.refreshToken !== null &&
		bundle.refreshToken !== undefined &&
		bundle.refreshToken.length > 0
	);
}

/**
 * The full silent-refresh trigger: time says refresh AND a refresh token
 * exists. Callers that cannot act on a refresh (PAT-only providers) use
 * `shouldRefresh` alone to prompt re-auth.
 */
export function shouldSilentlyRefresh(
	bundle: Pick<AuthTokenBundle, 'expiresAt' | 'refreshToken'>,
	nowMs: number,
	options: ExpiryOptions = {},
): boolean {
	return shouldRefresh(bundle, nowMs, options) && canSilentlyRefresh(bundle);
}

// ---------------------------------------------------------------------------
// Per-token health (validation without global UI impact)
// ---------------------------------------------------------------------------

export type TokenHealthStatus =
	| 'active'
	| 'expiring'
	| 'expired'
	| 'no_expiry'
	| 'revoked'
	| 'malformed'
	| 'unreadable';

export interface TokenHealth {
	provider: TokenProvider;
	status: TokenHealthStatus;
	/** Epoch ms of the token's expiry, or null when unknown/unreadable. */
	expiresAtMs: number | null;
	/** Milliseconds until expiry (negative = already past). Null when unknown. */
	remainingMs: number | null;
	/** Short human-readable explanation for tooltips / inline banners. */
	message: string;
}

/**
 * Validate a single stored token row and produce a `TokenHealth` summary.
 *
 * Never throws: decryption failures, malformed bundles and revoked rows are
 * reported as per-token statuses so a single bad token can't break the whole
 * status surface. The result never contains secrets.
 */
export async function validateToken(
	row: UserToken,
	cipher: AuthTokenCipher,
	nowMs: number,
	options: ExpiryOptions = {},
): Promise<TokenHealth> {
	const base = { expiresAtMs: null, remainingMs: null };
	if (row.status === 'revoked') {
		return {
			...base,
			provider: row.provider,
			status: 'revoked',
			message: 'Token was revoked and cannot be used.',
		};
	}
	if (row.status === 'expired') {
		return {
			...base,
			provider: row.provider,
			status: 'expired',
			message: 'Token was marked expired.',
		};
	}

	let plaintext: string;
	try {
		plaintext = await cipher.decrypt(row.encrypted_value);
	} catch {
		return {
			...base,
			provider: row.provider,
			status: 'unreadable',
			message:
				'Token could not be decrypted (wrong secret or tampered payload).',
		};
	}

	let bundle: AuthTokenBundle;
	try {
		bundle = parseBundle(plaintext);
	} catch {
		return {
			...base,
			provider: row.provider,
			status: 'malformed',
			message: 'Stored token payload is malformed; re-connect the provider.',
		};
	}

	const expiry = tokenExpiry(bundle, nowMs, options);
	const status: TokenHealthStatus =
		expiry.state === 'unknown'
			? 'no_expiry'
			: expiry.state === 'expired'
				? 'expired'
				: expiry.state === 'expiring'
					? 'expiring'
					: 'active';
	const message =
		status === 'active'
			? 'Token is valid.'
			: status === 'expiring'
				? 'Token is close to expiry; a silent refresh will run.'
				: status === 'expired'
					? 'Token has expired; reconnect the provider.'
					: 'Token has no known expiry.';
	return {
		provider: row.provider,
		status,
		expiresAtMs: expiry.expiresAtMs,
		remainingMs: expiry.remainingMs,
		message,
	};
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type AuthTokenErrorCode =
	| 'token_missing'
	| 'token_revoked'
	| 'token_unreadable'
	| 'token_malformed'
	| 'server_misconfigured';

export class AuthTokenError extends Error {
	readonly code: AuthTokenErrorCode;

	constructor(code: AuthTokenErrorCode, message: string) {
		super(message);
		this.name = 'AuthTokenError';
		this.code = code;
	}
}

/** Minimal cipher surface so tests can inject a fake. */
export interface AuthTokenCipher {
	encrypt(plaintext: string): Promise<string>;
	decrypt(payload: string): Promise<string>;
}

export interface AuthTokenServiceOptions {
	/** Injectable env reader (tests). Defaults to `process.env`. */
	env?: Partial<Record<string, string | undefined>> & {
		TOKEN_ENCRYPTION_SECRET?: string;
	};
	/** Injectable token store (tests). Defaults to `makeTokenStorage(env)`. */
	storage?: TokenStorage;
	/** Injectable cipher (tests). Defaults to `makeAesCipher(secret)`. */
	cipher?: AuthTokenCipher;
	/** Injectable clock (tests). Defaults to `Date.now()`. */
	nowMs?: number;
	/** Expiry defaults for validation / refresh triggers. */
	expiry?: ExpiryOptions;
}

export interface AuthTokenService {
	/**
	 * Encrypt + persist a plaintext token bundle. The plaintext never
	 * reaches the database. Returns the stored row (no secrets).
	 */
	saveToken(
		userId: string,
		provider: TokenProvider,
		input: SaveTokenInput,
	): Promise<UserToken>;
	/**
	 * Read + decrypt a token bundle for use (proxy injection, refresh
	 * decision). Returns null when no token exists. Fails closed
	 * (`AuthTokenError`) on revoked, unreadable or malformed rows.
	 */
	getDecryptedToken(
		userId: string,
		provider: TokenProvider,
	): Promise<AuthTokenBundle | null>;
	/**
	 * Per-token health for every stored token, oldest first. Never throws
	 * for per-token failures and never includes secrets — the UI surface.
	 */
	listStatuses(userId: string): Promise<TokenHealth[]>;
	/**
	 * The silent-refresh trigger: inspect a single token and report whether
	 * (and how) it should be refreshed. Never throws for per-token issues.
	 * Returns null when no token exists for the provider.
	 */
	silentRefreshDecision(
		userId: string,
		provider: TokenProvider,
	): Promise<RefreshDecision | null>;
	revokeToken(
		userId: string,
		provider: TokenProvider,
	): Promise<UserToken | null>;
	deleteToken(userId: string, provider: TokenProvider): Promise<boolean>;
}

export interface RefreshDecision {
	provider: TokenProvider;
	/** The expiry state, or one of the inspection failure states. */
	state: TokenExpiryState | 'missing' | 'unreadable' | 'malformed' | 'revoked';
	/** Time-based trigger — refresh window (lead or skew grace) reached. */
	shouldRefresh: boolean;
	/** A refresh token is available, so a silent refresh is possible. */
	canRefresh: boolean;
	/** Combine both: act on this token's expiry right now. */
	shouldSilentlyRefresh: boolean;
	expiresAtMs: number | null;
	remainingMs: number | null;
}

export function makeAuthTokenService(
	options: AuthTokenServiceOptions = {},
): AuthTokenService {
	const env =
		options.env ?? (process.env as Partial<Record<string, string | undefined>>);
	const secret = env.TOKEN_ENCRYPTION_SECRET;
	if (!secret || secret.length === 0) {
		throw new AuthTokenError(
			'server_misconfigured',
			'authTokenService: TOKEN_ENCRYPTION_SECRET must be set.',
		);
	}
	const storage = options.storage ?? makeTokenStorage(env as TokenStorageEnv);
	const cipher = options.cipher ?? makeAesCipher(secret, { iterations: 1_000 });
	const clock: () => number =
		options.nowMs !== undefined ? () => options.nowMs as number : Date.now;
	return new AuthTokenServiceImpl(storage, cipher, clock, options.expiry ?? {});
}

class AuthTokenServiceImpl implements AuthTokenService {
	constructor(
		private readonly storage: TokenStorage,
		private readonly cipher: AuthTokenCipher,
		private readonly clock: () => number,
		private readonly expiry: ExpiryOptions,
	) {}

	async saveToken(
		userId: string,
		provider: TokenProvider,
		input: SaveTokenInput,
	): Promise<UserToken> {
		if (
			typeof input.accessToken !== 'string' ||
			input.accessToken.length === 0
		) {
			throw new AuthTokenError(
				'token_malformed',
				'authTokenService.saveToken: accessToken must be a non-empty string.',
			);
		}
		if (input.expiresAt !== undefined && input.expiresAt !== null) {
			if (!isValidIsoTimestamp(input.expiresAt)) {
				throw new AuthTokenError(
					'token_malformed',
					'authTokenService.saveToken: expiresAt must be an ISO timestamp.',
				);
			}
		}
		const bundle: AuthTokenBundle = {
			version: AUTH_TOKEN_BUNDLE_VERSION,
			provider,
			accessToken: input.accessToken,
			refreshToken: input.refreshToken ?? null,
			expiresAt: input.expiresAt ?? null,
			tokenType: input.tokenType ?? null,
			scope: input.scope ?? null,
		};
		const encrypted = await this.cipher.encrypt(serializeBundle(bundle));
		return this.storage.upsertToken(userId, {
			provider,
			encrypted_value: encrypted,
			label: input.label,
			status: 'active',
		});
	}

	async getDecryptedToken(
		userId: string,
		provider: TokenProvider,
	): Promise<AuthTokenBundle | null> {
		const row = await this.storage.getToken(userId, provider);
		if (!row) return null;
		if (row.status === 'revoked') {
			throw new AuthTokenError(
				'token_revoked',
				`authTokenService.getDecryptedToken: ${provider} token is revoked.`,
			);
		}
		const bundle = await this.decryptOrThrow(row);
		// The token was read successfully — reflect that on the row. A bump
		// failure is non-fatal: the caller still gets the token.
		try {
			await this.storage.bumpLastUsed(userId, provider);
		} catch {
			// ignore — bookkeeping only
		}
		return bundle;
	}

	async listStatuses(userId: string): Promise<TokenHealth[]> {
		const rows = await this.storage.listTokens(userId);
		const nowMs = this.clock();
		const health: TokenHealth[] = [];
		for (const row of rows) {
			// Per-token isolation: one bad token never throws for the set.
			try {
				health.push(await validateToken(row, this.cipher, nowMs, this.expiry));
			} catch {
				health.push({
					provider: row.provider,
					status: 'unreadable',
					expiresAtMs: null,
					remainingMs: null,
					message: 'Token health could not be determined.',
				});
			}
		}
		return health;
	}

	async silentRefreshDecision(
		userId: string,
		provider: TokenProvider,
	): Promise<RefreshDecision | null> {
		const row = await this.storage.getToken(userId, provider);
		if (!row) return null;
		const nowMs = this.clock();

		if (row.status === 'revoked') {
			return {
				provider,
				state: 'revoked',
				shouldRefresh: false,
				canRefresh: false,
				shouldSilentlyRefresh: false,
				expiresAtMs: null,
				remainingMs: null,
			};
		}
		if (row.status === 'expired') {
			return {
				provider,
				state: 'expired',
				shouldRefresh: false,
				canRefresh: false,
				shouldSilentlyRefresh: false,
				expiresAtMs: null,
				remainingMs: null,
			};
		}

		let bundle: AuthTokenBundle;
		try {
			bundle = await this.decryptOrThrow(row);
		} catch (err) {
			if (err instanceof AuthTokenError && err.code === 'token_unreadable') {
				return {
					provider,
					state: 'unreadable',
					shouldRefresh: false,
					canRefresh: false,
					shouldSilentlyRefresh: false,
					expiresAtMs: null,
					remainingMs: null,
				};
			}
			if (err instanceof AuthTokenError && err.code === 'token_malformed') {
				return {
					provider,
					state: 'malformed',
					shouldRefresh: false,
					canRefresh: false,
					shouldSilentlyRefresh: false,
					expiresAtMs: null,
					remainingMs: null,
				};
			}
			throw err;
		}

		const expiry = tokenExpiry(bundle, nowMs, this.expiry);
		const timeTriggered = expiry.state === 'expiring';
		const canRefresh = canSilentlyRefresh(bundle);
		return {
			provider,
			state: expiry.state,
			shouldRefresh: timeTriggered,
			canRefresh,
			shouldSilentlyRefresh: timeTriggered && canRefresh,
			expiresAtMs: expiry.expiresAtMs,
			remainingMs: expiry.remainingMs,
		};
	}

	revokeToken(
		userId: string,
		provider: TokenProvider,
	): Promise<UserToken | null> {
		return this.storage.revokeToken(userId, provider);
	}

	deleteToken(userId: string, provider: TokenProvider): Promise<boolean> {
		return this.storage.deleteToken(userId, provider);
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private async decryptOrThrow(row: UserToken): Promise<AuthTokenBundle> {
		let plaintext: string;
		try {
			plaintext = await this.cipher.decrypt(row.encrypted_value);
		} catch {
			throw new AuthTokenError(
				'token_unreadable',
				`authTokenService: ${row.provider} token could not be decrypted (wrong secret or tampered payload).`,
			);
		}
		return parseBundle(plaintext);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidIsoTimestamp(value: string): boolean {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return false;
	// Reject non-ISO strings that Date.parse still accepts (e.g. "2026-01-01").
	return /^\d{4}-\d{2}-\d{2}T/.test(value);
}
