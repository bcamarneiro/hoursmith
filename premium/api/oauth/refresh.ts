/**
 * OAuth refresh endpoint for Hoursmith Premium (ADA-648).
 *
 * `POST /api/oauth/refresh` with a Supabase JWT and
 * `{ provider: 'jira_api' | 'gitlab' | 'github', refresh_token: '<stored>' }`:
 * exchanges the stored refresh token with the provider for a fresh access
 * token, encrypts the new bundle (via `aesCrypto.ts`), and upserts it into
 * `user_tokens` — all server-side, synchronously, before responding.
 *
 * The frontend only ever holds the refresh token in memory for this call; the
 * access token is stored encrypted and is injected by the hosted proxy at
 * request time. Response bodies never contain tokens.
 *
 * Request contract:
 *   - Authorization: Bearer <Supabase JWT>  (confirmed live with GoTrue —
 *     low-traffic endpoint, and it mutates the user's token row)
 *   - Body: { provider, refresh_token }
 *
 * Responses:
 *   - 200 { ok: true, provider, token_type, scope, expires_in }
 *   - 400 invalid_body | unsupported_provider | invalid_refresh_token
 *   - 401 missing_token | invalid_token
 *   - 502 upstream_error | exchange_failed
 *   - 504 upstream_timeout
 *   - 500 server_misconfigured | token_refresh_failed
 *
 * Logging discipline (compliance-critical):
 *   DO log:    timestamp, user_id, provider, status, duration.
 *   DO NOT log: request body, refresh/access tokens, Authorization header,
 *               provider error payloads.
 *
 * Linear: ADA-648.
 */

import { makeAesCipher } from '../_lib/aesCrypto.js';
import { userIdFromToken } from '../_lib/auth.js';
import { corsHeaders } from '../_lib/cors.js';
import {
	buildTokenBundle,
	exchangeRefreshToken,
	isRefreshProvider,
	OAuthExchangeError,
	serializeBundle,
	type ExchangeResult,
	type RefreshProvider,
} from '../_lib/oauthExchange.js';
import { makeTokenStorage, type TokenStorage } from '../_lib/tokenStorage.js';

// Pin to Frankfurt for GDPR residency. Mirrors vercel.json.
export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

type Env = Partial<Record<string, string | undefined>>;

/** Minimal cipher surface so tests can inject a fake. */
export interface TokenCipher {
	encrypt(plaintext: string): Promise<string>;
}

/** Max accepted request body — the payload is two small fields. */
const MAX_BODY_BYTES = 16 * 1024;
/** Generous ceiling; real OAuth refresh tokens are well under 1 KB. */
const MAX_REFRESH_TOKEN_CHARS = 4096;

export interface RefreshDeps {
	/** Injectable env reader (tests). Defaults to `process.env`. */
	env?: Env;
	/** Injectable JWT verification (tests). Defaults to live GoTrue check. */
	verifyJwt?: (token: string) => Promise<string | null>;
	/** Injectable provider exchange (tests). Defaults to `exchangeRefreshToken`. */
	exchange?: (input: {
		provider: RefreshProvider;
		refreshToken: string;
	}) => Promise<ExchangeResult>;
	/** Injectable encryption (tests). Defaults to `AesCipher(TOKEN_ENCRYPTION_SECRET)`. */
	cipher?: TokenCipher;
	/** Injectable token store (tests). Defaults to `makeTokenStorage(env)`. */
	storage?: TokenStorage;
	/** Injectable clock (tests). Defaults to `Date.now()`. */
	nowMs?: number;
}

export default async function handler(request: Request): Promise<Response> {
	return handleRefresh(request);
}

export async function handleRefresh(
	request: Request,
	deps: RefreshDeps = {},
): Promise<Response> {
	const start = Date.now();
	const env = deps.env ?? process.env;
	const origin = request.headers.get('origin');

	// Preflight: respond without auth so the browser can probe.
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders(origin) });
	}

	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' }, origin);
	}

	// 1. Auth: confirm the Supabase JWT against GoTrue. This endpoint mutates
	//    the user's own token row, so a live check beats a local decode.
	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		logRefresh({
			userId: null,
			provider: null,
			code: 'missing_token',
			status: 401,
			durationMs: Date.now() - start,
		});
		return jsonResponse(401, { error: 'missing_token' }, origin);
	}

	const verifyJwt =
		deps.verifyJwt ??
		((t: string) => userIdFromToken(t, { confirmWithServer: true, env }));
	const userId = await verifyJwt(token);
	if (!userId) {
		logRefresh({
			userId: null,
			provider: null,
			code: 'invalid_token',
			status: 401,
			durationMs: Date.now() - start,
		});
		return jsonResponse(401, { error: 'invalid_token' }, origin);
	}

	// 2. Wire up encryption + storage. Fail cleanly when env is missing so an
	//    operator misconfiguration surfaces as a clear 500, never a crash.
	let cipher: TokenCipher;
	let storage: TokenStorage;
	try {
		cipher = deps.cipher ?? makeAesCipher(env.TOKEN_ENCRYPTION_SECRET ?? '');
		storage = deps.storage ?? makeTokenStorage(env);
	} catch (err) {
		logRefresh({
			userId,
			provider: null,
			code: 'server_misconfigured',
			status: 500,
			durationMs: Date.now() - start,
			detail: (err as Error).message,
		});
		return jsonResponse(500, { error: 'server_misconfigured' }, origin);
	}

	// 3. Parse + validate the body (input validation, ADA-648).
	const contentLength = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
		logRefresh({
			userId,
			provider: null,
			code: 'payload_too_large',
			status: 413,
			durationMs: Date.now() - start,
		});
		return jsonResponse(413, { error: 'payload_too_large' }, origin);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		body = null;
	}
	const input = parseRefreshInput(body);
	if (input.ok) {
		// valid input, fall through to the exchange
	} else {
		const code = input.code;
		logRefresh({
			userId,
			provider: null,
			code,
			status: 400,
			durationMs: Date.now() - start,
		});
		return jsonResponse(400, { error: code }, origin);
	}

	// 4. Exchange the refresh token with the provider.
	const exchange = deps.exchange ?? ((i) => exchangeRefreshToken(i, { env }));
	let result: ExchangeResult;
	try {
		result = await exchange({
			provider: input.provider,
			refreshToken: input.refreshToken,
		});
	} catch (err) {
		if (err instanceof OAuthExchangeError) {
			const mapped = mapExchangeError(err);
			logRefresh({
				userId,
				provider: input.provider,
				code: mapped.code,
				status: mapped.status,
				durationMs: Date.now() - start,
			});
			return jsonResponse(mapped.status, { error: mapped.code }, origin);
		}
		logRefresh({
			userId,
			provider: input.provider,
			code: 'exchange_failed',
			status: 502,
			durationMs: Date.now() - start,
			detail: (err as Error).message,
		});
		return jsonResponse(502, { error: 'exchange_failed' }, origin);
	}

	// 5. Encrypt the fresh bundle and store it synchronously (ADA-648).
	const bundle = buildTokenBundle(result, input.provider, deps.nowMs ?? Date.now());
	try {
		const encrypted = await cipher.encrypt(serializeBundle(bundle));
		await storage.upsertToken(userId, {
			provider: input.provider,
			encrypted_value: encrypted,
			status: 'active',
		});
	} catch (err) {
		logRefresh({
			userId,
			provider: input.provider,
			code: 'token_refresh_failed',
			status: 500,
			durationMs: Date.now() - start,
			detail: (err as Error).message,
		});
		return jsonResponse(500, { error: 'token_refresh_failed' }, origin);
	}

	logRefresh({
		userId,
		provider: input.provider,
		code: 'ok',
		status: 200,
		durationMs: Date.now() - start,
	});
	// No tokens in the response — the bundle is only ever read server-side.
	return jsonResponse(
		200,
		{
			ok: true,
			provider: input.provider,
			token_type: result.tokenType,
			scope: result.scope,
			expires_in: result.expiresIn,
		},
		origin,
	);
}

type ParseResult =
	| { ok: true; provider: RefreshProvider; refreshToken: string }
	| { ok: false; code: 'invalid_body' | 'unsupported_provider' | 'invalid_refresh_token' };

function parseRefreshInput(body: unknown): ParseResult {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return { ok: false, code: 'invalid_body' };
	}
	const raw = body as { provider?: unknown; refresh_token?: unknown };
	if (typeof raw.provider !== 'string' || !isRefreshProvider(raw.provider)) {
		return { ok: false, code: 'unsupported_provider' };
	}
	if (
		typeof raw.refresh_token !== 'string' ||
		raw.refresh_token.length === 0 ||
		raw.refresh_token.length > MAX_REFRESH_TOKEN_CHARS
	) {
		return { ok: false, code: 'invalid_refresh_token' };
	}
	return {
		ok: true,
		provider: raw.provider,
		refreshToken: raw.refresh_token,
	};
}

function mapExchangeError(err: OAuthExchangeError): {
	status: number;
	code: string;
} {
	switch (err.code) {
		// Stored token is dead → client should clear it and re-auth the provider.
		case 'invalid_grant':
			return { status: 400, code: 'invalid_refresh_token' };
		case 'invalid_client':
			return { status: 500, code: 'server_misconfigured' };
		case 'upstream_timeout':
			return { status: 504, code: 'upstream_timeout' };
		case 'server_misconfigured':
			return { status: 500, code: 'server_misconfigured' };
		default:
			return { status: 502, code: 'upstream_error' };
	}
}

function extractBearer(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}

function jsonResponse(
	status: number,
	body: Record<string, unknown>,
	origin: string | null,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			...corsHeaders(origin),
		},
	});
}

interface RefreshLogFields {
	userId: string | null;
	provider: RefreshProvider | null;
	code: string;
	status: number;
	durationMs: number;
	detail?: string;
}

/** Structured log line. Scrubbed: no tokens, no headers, no body. */
function logRefresh(fields: RefreshLogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-oauth-refresh',
			user_id: fields.userId,
			provider: fields.provider,
			code: fields.code,
			status: fields.status,
			duration_ms: fields.durationMs,
			...(fields.detail ? { detail: fields.detail } : {}),
		}),
	);
}
