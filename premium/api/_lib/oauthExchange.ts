/**
 * External OAuth2 refresh-token exchange for Hoursmith Premium (ADA-648).
 *
 * The account token page stores third-party credentials in `user_tokens`
 * (encrypted at rest via `aesCrypto.ts`). OAuth2 providers issue short-lived
 * access tokens, so the stored bundle needs a server-side refresh path:
 * `POST /api/oauth/refresh` calls `exchangeRefreshToken` here, gets fresh
 * credentials, and rewrites the encrypted bundle.
 *
 * Supported providers (only those with a standard `refresh_token` grant are
 * listed — PAT-based providers like RescueTime have no refresh flow):
 *   - jira_api  → Atlassian OAuth2 (`https://auth.atlassian.com/oauth/token`)
 *   - gitlab    → GitLab.com OAuth2 (`https://gitlab.com/oauth/token`)
 *   - github    → GitHub OAuth2 (`https://github.com/login/oauth/access_token`)
 *
 * Client credentials come from env (`*_OAUTH_CLIENT_ID` / `*_OAUTH_CLIENT_SECRET`)
 * and are never exposed to the browser. The exchange is a plain
 * `grant_type=refresh_token` form POST; every provider returns JSON (GitHub is
 * asked for JSON via `Accept`, otherwise it replies form-encoded).
 *
 * Error taxonomy (mirrored by the endpoint into HTTP status codes):
 *   invalid_grant        → the refresh token is expired/revoked (client re-auth)
 *   invalid_client       → the provider rejected OUR client credentials (operator)
 *   upstream_error       → provider answered with an error we don't classify
 *   upstream_timeout     → provider didn't answer within `timeoutMs`
 *   server_misconfigured → client id/secret env vars are missing
 *
 * Dependency-free (fetch only) so this stays edge-runtime compatible,
 * mirroring `polarClient.ts` and `tokenStorage.ts`.
 *
 * Linear: ADA-648 (token storage), ADA-677 (encryption).
 */

export type RefreshProvider = 'jira_api' | 'gitlab' | 'github';

/**
 * Providers with a refresh-token grant. Kept as a separate list from
 * `TokenProvider` (tokenStorage.ts) because PAT-only providers (rescuetime,
 * toggl, harvest, clockify) have no OAuth refresh flow.
 */
export const REFRESH_PROVIDERS: readonly RefreshProvider[] = [
	'jira_api',
	'gitlab',
	'github',
];

export function isRefreshProvider(value: string): value is RefreshProvider {
	return (REFRESH_PROVIDERS as readonly string[]).includes(value);
}

type Env = Partial<Record<string, string | undefined>>;

interface ProviderConfig {
	tokenEndpoint: string;
	clientIdEnv: string;
	clientSecretEnv: string;
}

const PROVIDER_CONFIGS: Record<RefreshProvider, ProviderConfig> = {
	jira_api: {
		tokenEndpoint: 'https://auth.atlassian.com/oauth/token',
		clientIdEnv: 'JIRA_OAUTH_CLIENT_ID',
		clientSecretEnv: 'JIRA_OAUTH_CLIENT_SECRET',
	},
	gitlab: {
		tokenEndpoint: 'https://gitlab.com/oauth/token',
		clientIdEnv: 'GITLAB_OAUTH_CLIENT_ID',
		clientSecretEnv: 'GITLAB_OAUTH_CLIENT_SECRET',
	},
	github: {
		tokenEndpoint: 'https://github.com/login/oauth/access_token',
		clientIdEnv: 'GITHUB_OAUTH_CLIENT_ID',
		clientSecretEnv: 'GITHUB_OAUTH_CLIENT_SECRET',
	},
};

/** Normalized result of a successful exchange (never logged, never echoed). */
export interface ExchangeResult {
	accessToken: string;
	/**
	 * Rotated refresh token when the provider issues one; falls back to the
	 * input refresh token for providers that don't rotate.
	 */
	refreshToken: string;
	/** Access-token lifetime in seconds, when the provider reports it. */
	expiresIn: number | null;
	scope: string | null;
	tokenType: string | null;
}

export type OAuthExchangeErrorCode =
	| 'invalid_grant'
	| 'invalid_client'
	| 'upstream_error'
	| 'upstream_timeout'
	| 'server_misconfigured';

export class OAuthExchangeError extends Error {
	readonly code: OAuthExchangeErrorCode;
	/** Upstream HTTP status when the error came from the provider. */
	readonly upstreamStatus: number | null;

	constructor(
		code: OAuthExchangeErrorCode,
		message: string,
		upstreamStatus: number | null = null,
	) {
		super(message);
		this.name = 'OAuthExchangeError';
		this.code = code;
		this.upstreamStatus = upstreamStatus;
	}
}

export interface ExchangeInput {
	provider: RefreshProvider;
	refreshToken: string;
}

export interface ExchangeOptions {
	/** Injectable env reader (tests). Defaults to `process.env`. */
	env?: Env;
	/** Injectable fetch (tests). Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
	/** Provider timeout in ms (tests can shrink it). */
	timeoutMs?: number;
}

/** Default ceiling for the upstream token endpoint round-trip. */
export const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;

export async function exchangeRefreshToken(
	input: ExchangeInput,
	options: ExchangeOptions = {},
): Promise<ExchangeResult> {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;

	const config = PROVIDER_CONFIGS[input.provider];
	const clientId = env[config.clientIdEnv];
	const clientSecret = env[config.clientSecretEnv];
	if (!clientId || !clientSecret) {
		throw new OAuthExchangeError(
			'server_misconfigured',
			`oauthExchange: ${config.clientIdEnv} and ${config.clientSecretEnv} must be set.`,
		);
	}

	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: input.refreshToken,
	});

	let res: Response;
	try {
		res = await fetchWithTimeout(
			fetchImpl,
			config.tokenEndpoint,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					accept: 'application/json',
				},
				body: body.toString(),
			},
			timeoutMs,
		);
	} catch (err) {
		if (isAbortError(err)) {
			throw new OAuthExchangeError(
				'upstream_timeout',
				`oauthExchange: ${input.provider} token endpoint timed out after ${timeoutMs}ms.`,
			);
		}
		throw new OAuthExchangeError(
			'upstream_error',
			`oauthExchange: ${input.provider} token endpoint request failed: ${(err as Error).message}`,
		);
	}

	if (!res.ok) {
		throw new OAuthExchangeError(
			classifyErrorStatus(await readErrorPayload(res)),
			`oauthExchange: ${input.provider} token endpoint returned ${res.status}.`,
			res.status,
		);
	}

	const raw = (await readJsonSafely(res)) as Record<string, unknown> | null;
	const accessToken = raw?.access_token;
	if (typeof accessToken !== 'string' || accessToken.length === 0) {
		throw new OAuthExchangeError(
			'upstream_error',
			`oauthExchange: ${input.provider} token endpoint returned a malformed success payload.`,
		);
	}

	return {
		accessToken,
		refreshToken: pickString(raw?.refresh_token) ?? input.refreshToken,
		expiresIn: pickPositiveNumber(raw?.expires_in),
		scope: pickString(raw?.scope),
		tokenType: pickString(raw?.token_type),
	};
}

// ---------------------------------------------------------------------------
// Stored token bundle (the plaintext that lives inside encrypted_value)
// ---------------------------------------------------------------------------

export const TOKEN_BUNDLE_VERSION = 1;

/**
 * Plaintext shape stored (encrypted) in `user_tokens.encrypted_value`.
 * The proxy decrypts this later to inject `accessToken` upstream; the
 * frontend never sees it.
 */
export interface TokenBundle {
	version: typeof TOKEN_BUNDLE_VERSION;
	provider: RefreshProvider;
	accessToken: string;
	refreshToken: string;
	/** ISO timestamp when the access token expires (null if unknown). */
	expiresAt: string | null;
	scope: string | null;
	tokenType: string | null;
}

export function buildTokenBundle(
	result: ExchangeResult,
	provider: RefreshProvider,
	nowMs: number,
): TokenBundle {
	return {
		version: TOKEN_BUNDLE_VERSION,
		provider,
		accessToken: result.accessToken,
		refreshToken: result.refreshToken,
		expiresAt:
			result.expiresIn === null || result.expiresIn <= 0
				? null
				: new Date(nowMs + result.expiresIn * 1000).toISOString(),
		scope: result.scope,
		tokenType: result.tokenType,
	};
}

export function serializeBundle(bundle: TokenBundle): string {
	return JSON.stringify(bundle);
}

/**
 * Parse + validate a stored bundle. Throws on malformed payloads or an
 * unknown version — callers (endpoint, future proxy consumer) fail closed.
 */
export function parseBundle(payload: string): TokenBundle {
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		throw new Error('oauthExchange.parseBundle: payload is not valid JSON.');
	}
	if (!raw || typeof raw !== 'object') {
		throw new Error('oauthExchange.parseBundle: payload must be an object.');
	}
	const bundle = raw as Partial<TokenBundle>;
	if (bundle.version !== TOKEN_BUNDLE_VERSION) {
		throw new Error(
			`oauthExchange.parseBundle: unsupported bundle version ${String(bundle.version)}.`,
		);
	}
	if (
		!isRefreshProvider(bundle.provider ?? '') ||
		typeof bundle.accessToken !== 'string' ||
		typeof bundle.refreshToken !== 'string'
	) {
		throw new Error('oauthExchange.parseBundle: payload is malformed.');
	}
	return bundle as TokenBundle;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	// Only our own timeout aborts the request, so AbortError ⇒ upstream timeout.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function isAbortError(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === 'AbortError' || err.name === 'TimeoutError')
	);
}

function classifyErrorStatus(
	payload: { error?: unknown } | null,
): OAuthExchangeErrorCode {
	const error = pickString(payload?.error);
	if (error === 'invalid_grant') return 'invalid_grant';
	if (error === 'invalid_client') return 'invalid_client';
	// Non-2xx without a recognizable OAuth2 error field.
	return 'upstream_error';
}

async function readErrorPayload(
	res: Response,
): Promise<{ error?: unknown } | null> {
	const raw = (await readJsonSafely(res)) as Record<string, unknown> | null;
	if (!raw || typeof raw !== 'object') return null;
	return raw;
}

async function readJsonSafely(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

function pickString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function pickPositiveNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? value
		: null;
}
