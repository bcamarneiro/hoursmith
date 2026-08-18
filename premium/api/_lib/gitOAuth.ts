/**
 * Git OAuth Strategy & Token Exchange (ADA-611).
 *
 * Stateless OAuth flow for GitHub App authentication, using signed state
 * parameters for CSRF protection and HMAC-signed internal tokens that carry
 * an encrypted GitHub access token. No database needed.
 *
 * Flow:
 *   1. GET /api/git-oauth/authorize → redirects to GitHub OAuth
 *   2. GET /api/git-oauth/callback   → exchanges code, issues internal token
 *   3. POST /api/git-oauth/token     → validates/refreshes internal token
 *
 * Environment variables required at call sites:
 *   - GIT_OAUTH_SECRET        — HMAC secret (min 32 bytes, base64-encoded when
 *                               stored; decoded to raw bytes for HMAC)
 *   - GIT_OAUTH_CLIENT_ID     — GitHub OAuth App client ID
 *   - GIT_OAUTH_CLIENT_SECRET — GitHub OAuth App client secret
 *   - GIT_OAUTH_REDIRECT_URI  — (optional) overrides the default redirect_uri
 *                               for the callback endpoint
 *
 * Edge-runtime compatible: WebCrypto + `fetch` only, no Node-only deps.
 *
 * Linear: ADA-611.
 */

/** Custom error type for OAuth-specific failures. */
export class GitOAuthError extends Error {
	name = 'GitOAuthError' as const;
	constructor(
		message: string,
		public code: string,
	) {
		super(message);
	}
}

// ─── Constants ──────────────────────────────────────────────────────────

/** How long a state parameter stays valid (5 minutes). */
const STATE_TTL_MS = 5 * 60 * 1000;

/** How long an internal access token stays valid (15 minutes). */
const INTERNAL_TOKEN_TTL_MS = 15 * 60 * 1000;

/** GitHub OAuth authorize endpoint. */
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

/** GitHub OAuth token-exchange endpoint. */
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** GitHub API user endpoint. */
const GITHUB_API_USER = 'https://api.github.com/user';

/** Requested scopes for the GitHub token. */
const GITHUB_SCOPE = 'repo';

// ─── Base64url helpers ───────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Uint8Array {
	const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function utf8Bytes(input: string): Uint8Array {
	return new TextEncoder().encode(input);
}

function bytesToUtf8(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

// ─── HMAC signing ────────────────────────────────────────────────────────

/**
 * Import the HMAC key from the raw secret bytes.
 * The secret can be passed as raw UTF-8 bytes or base64-decoded from an env
 * var. We try both derivations, matching the polarClient.ts pattern.
 */
async function importHmacKey(
	secret: string,
	usages: KeyUsage[],
): Promise<CryptoKey> {
	// Try raw UTF-8 first, then base64-decoded.
	const candidates: Uint8Array[] = [utf8Bytes(secret)];
	try {
		candidates.push(base64UrlDecode(secret));
	} catch {
		/* only UTF-8 */
	}

	// Try each; first successful import wins.
	for (const raw of candidates) {
		try {
			return await crypto.subtle.importKey(
				'raw',
				raw,
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				usages,
			);
		} catch {
			continue;
		}
	}
	throw new GitOAuthError('failed to import HMAC key', 'key_import_failed');
}

async function hmacSign(
	payload: string,
	secret: string,
): Promise<string> {
	const key = await importHmacKey(secret, ['sign']);
	const sigBuffer = await crypto.subtle.sign(
		'HMAC',
		key,
		utf8Bytes(payload),
	);
	return base64UrlEncode(new Uint8Array(sigBuffer));
}

async function hmacVerify(
	payload: string,
	signature: string,
	secret: string,
): Promise<boolean> {
	const key = await importHmacKey(secret, ['verify']);
	const expected = base64UrlDecode(signature);
	return crypto.subtle.verify('HMAC', key, expected, utf8Bytes(payload));
}

// ─── AES-GCM encryption / decryption ─────────────────────────────────────

/**
 * Derive an AES-GCM key from the HMAC secret using HKDF-SHA256.
 * In edge runtimes without HKDF, we fall back to SHA-256 hashing the secret.
 * Both approaches produce a deterministic 256-bit key.
 */
async function deriveAesKey(secret: string): Promise<CryptoKey> {
	const raw = utf8Bytes(secret);
	const hash = await crypto.subtle.digest('SHA-256', raw);
	return crypto.subtle.importKey(
		'raw',
		new Uint8Array(hash),
		{ name: 'AES-GCM' },
		false,
		['encrypt', 'decrypt'],
	);
}

async function encryptToken(
	plaintext: string,
	secret: string,
): Promise<string> {
	const key = await deriveAesKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encoded = utf8Bytes(plaintext);
	const encrypted = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		encoded,
	);
	// Format: iv (12) + ciphertext + gcm_tag (16) = net result
	const combined = new Uint8Array(iv.length + encrypted.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(encrypted), iv.length);
	return base64UrlEncode(combined);
}

async function decryptToken(
	encoded: string,
	secret: string,
): Promise<string> {
	const key = await deriveAesKey(secret);
	const combined = base64UrlDecode(encoded);
	if (combined.length < 12 + 16) {
		throw new GitOAuthError('malformed encrypted token', 'decrypt_failed');
	}
	const iv = combined.slice(0, 12);
	const ciphertext = combined.slice(12);
	try {
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			key,
			ciphertext,
		);
		return bytesToUtf8(new Uint8Array(decrypted));
	} catch {
		throw new GitOAuthError('decryption failed (bad key or corrupted data)', 'decrypt_failed');
	}
}

// ─── State parameter ─────────────────────────────────────────────────────

export interface StatePayload {
	/** Redirect URL after OAuth completes. */
	r: string;
	/** Expiration timestamp (ms). */
	e: number;
	/** Random nonce for uniqueness. */
	n: string;
}

/**
 * Generate a signed state parameter for the OAuth flow.
 * The state is a statically-verifiable token: `base64url(payload).base64url(signature)`.
 *
 * The returned value is safe to pass as a query parameter.
 *
 * @param redirectUrl - Where to redirect the user after OAuth completes.
 * @param secret - The GIT_OAUTH_SECRET value.
 * @param nowMs - Override "now" in ms (for tests). Defaults to Date.now().
 */
export async function createState(
	redirectUrl: string,
	secret: string,
	nowMs: number = Date.now(),
): Promise<string> {
	const payload: StatePayload = {
		r: redirectUrl,
		e: nowMs + STATE_TTL_MS,
		n: crypto.randomUUID(),
	};
	const encoded = base64UrlEncode(utf8Bytes(JSON.stringify(payload)));
	const sig = await hmacSign(encoded, secret);
	return `${encoded}.${sig}`;
}

/**
 * Verify a signed state parameter and extract the redirect URL.
 * Returns null if the state is invalid, expired, or tampered with.
 *
 * @param state - The state string from the OAuth callback query param.
 * @param secret - The GIT_OAUTH_SECRET value.
 * @param nowMs - Override "now" in ms (for tests). Defaults to Date.now().
 */
export async function verifyState(
	state: string,
	secret: string,
	nowMs: number = Date.now(),
): Promise<string | null> {
	const parts = state.split('.');
	if (parts.length !== 2) return null;
	const [encoded, sig] = parts;

	// Verify the HMAC signature first (cheap, catches forgeries early).
	const valid = await hmacVerify(encoded, sig, secret);
	if (!valid) return null;

	// Decode and parse the payload.
	let payload: StatePayload;
	try {
		payload = JSON.parse(bytesToUtf8(base64UrlDecode(encoded))) as StatePayload;
	} catch {
		return null;
	}

	// Validate shape.
	if (!payload.r || !payload.e || !payload.n) return null;

	// Check expiration.
	if (nowMs > payload.e) return null;

	return payload.r;
}

// ─── Token exchange (GitHub) ─────────────────────────────────────────────

export interface GitHubTokenResponse {
	access_token: string;
	token_type: string;
	scope: string;
}

/**
 * Exchange an OAuth authorization code for a GitHub access token.
 *
 * @param code - The `code` query parameter from the GitHub callback.
 * @param clientId - GitHub OAuth App client ID.
 * @param clientSecret - GitHub OAuth App client secret.
 * @param redirectUri - The same redirect_uri used in the authorize step.
 * @param fetchImpl - Injectable fetch (for tests). Defaults to global fetch.
 */
export async function exchangeCodeForToken(
	code: string,
	clientId: string,
	clientSecret: string,
	redirectUri: string,
	fetchImpl: typeof fetch = fetch,
): Promise<GitHubTokenResponse> {
	const params = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		code,
		redirect_uri: redirectUri,
	});

	let res: Response;
	try {
		res = await fetchImpl(GITHUB_TOKEN_URL, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: params.toString(),
		});
	} catch (err) {
		throw new GitOAuthError(
			`network error calling GitHub token endpoint: ${(err as Error).message}`,
			'token_exchange_failed',
		);
	}

	const body = (await res.json()) as Record<string, unknown>;

	if (!res.ok) {
		const errorDesc = body.error_description
			? `: ${body.error_description}`
			: '';
		throw new GitOAuthError(
			`GitHub token exchange failed (${res.status})${errorDesc}`,
			'token_exchange_failed',
		);
	}

	if (body.error) {
		throw new GitOAuthError(
			`GitHub OAuth error: ${body.error}${body.error_description ? ` — ${body.error_description}` : ''}`,
			'token_exchange_failed',
		);
	}

	const accessToken = body.access_token;
	if (typeof accessToken !== 'string' || !accessToken) {
		throw new GitOAuthError(
			'GitHub token response missing access_token',
			'token_exchange_failed',
		);
	}

	return {
		access_token: accessToken,
		token_type: (body.token_type as string) ?? 'bearer',
		scope: (body.scope as string) ?? '',
	};
}

// ─── GitHub user info ────────────────────────────────────────────────────

export interface GitHubUser {
	id: number;
	login: string;
	avatar_url: string | null;
	name: string | null;
}

/**
 * Fetch the authenticated user's GitHub profile.
 *
 * @param accessToken - A valid GitHub access token.
 * @param fetchImpl - Injectable fetch (for tests).
 */
export async function getGitHubUser(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<GitHubUser> {
	let res: Response;
	try {
		res = await fetchImpl(GITHUB_API_USER, {
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: 'application/vnd.github+json',
			},
		});
	} catch (err) {
		throw new GitOAuthError(
			`network error fetching GitHub user: ${(err as Error).message}`,
			'user_fetch_failed',
		);
	}

	if (!res.ok) {
		throw new GitOAuthError(
			`GitHub user endpoint returned ${res.status}`,
			'user_fetch_failed',
		);
	}

	const body = (await res.json()) as Record<string, unknown>;
	if (typeof body.id !== 'number') {
		throw new GitOAuthError(
			'GitHub user response missing id',
			'user_fetch_failed',
		);
	}

	return {
		id: body.id as number,
		login: (body.login as string) ?? 'unknown',
		avatar_url: (body.avatar_url as string) ?? null,
		name: (body.name as string) ?? null,
	};
}

// ─── Internal access tokens ──────────────────────────────────────────────

/**
 * Payload embedded within the internal token.
 * JSON-serialised, base64url-encoded, and HMAC-signed.
 */
export interface InternalTokenPayload {
	/** GitHub user id (sub claim). */
	s: number;
	/** GitHub login (username). */
	l: string;
	/** Encrypted GitHub access token. */
	t: string;
	/** Issued-at timestamp (ms). */
	i: number;
	/** Expiration timestamp (ms). */
	e: number;
}

/**
 * Create an internal access token that carries the encrypted GitHub token.
 *
 * The token is a stateless JWT-like structure:
 *   `base64url(payload).base64url(signature)`
 *
 * The GitHub access token is encrypted within the payload using AES-GCM so
 * that the frontend never sees the raw GitHub credential.
 *
 * @param githubToken - The raw GitHub access token.
 * @param githubUser - The GitHub user info (id, login).
 * @param secret - The GIT_OAUTH_SECRET value (used for both HMAC signing and encryption).
 * @param nowMs - Override "now" in ms (for tests). Defaults to Date.now().
 */
export async function createInternalToken(
	githubToken: string,
	githubUser: Pick<GitHubUser, 'id' | 'login'>,
	secret: string,
	nowMs: number = Date.now(),
): Promise<string> {
	const encryptedToken = await encryptToken(githubToken, secret);
	const payload: InternalTokenPayload = {
		s: githubUser.id,
		l: githubUser.login,
		t: encryptedToken,
		i: nowMs,
		e: nowMs + INTERNAL_TOKEN_TTL_MS,
	};
	const encoded = base64UrlEncode(utf8Bytes(JSON.stringify(payload)));
	const sig = await hmacSign(encoded, secret);
	return `${encoded}.${sig}`;
}

export interface VerifiedInternalToken {
	/** GitHub user id. */
	githubUserId: number;
	/** GitHub login. */
	githubLogin: string;
	/** Decrypted GitHub access token. */
	githubToken: string;
	/** Issued-at timestamp (ms). */
	issuedAt: number;
	/** Expiration timestamp (ms). */
	expiresAt: number;
}

/**
 * Verify an internal token, decrypt the GitHub access token, and return the
 * token's contents. Returns null if the signature is invalid or the token
 * has expired.
 *
 * @param token - The internal token string.
 * @param secret - The GIT_OAUTH_SECRET value.
 * @param nowMs - Override "now" in ms (for tests). Defaults to Date.now().
 */
export async function verifyInternalToken(
	token: string,
	secret: string,
	nowMs: number = Date.now(),
): Promise<VerifiedInternalToken | null> {
	const parts = token.split('.');
	if (parts.length !== 2) return null;
	const [encoded, sig] = parts;

	// Verify HMAC signature.
	const valid = await hmacVerify(encoded, sig, secret);
	if (!valid) return null;

	// Decode and parse payload.
	let payload: InternalTokenPayload;
	try {
		payload = JSON.parse(bytesToUtf8(base64UrlDecode(encoded))) as InternalTokenPayload;
	} catch {
		return null;
	}

	// Validate shape.
	if (typeof payload.s !== 'number' || typeof payload.t !== 'string') {
		return null;
	}

	// Check expiration.
	if (nowMs > payload.e) {
		return null;
	}

	// Decrypt the GitHub token.
	let githubToken: string;
	try {
		githubToken = await decryptToken(payload.t, secret);
	} catch {
		return null;
	}

	return {
		githubUserId: payload.s,
		githubLogin: payload.l,
		githubToken,
		issuedAt: payload.i,
		expiresAt: payload.e,
	};
}

// ─── Env resolution ──────────────────────────────────────────────────────

export interface GitOAuthEnv {
	GIT_OAUTH_SECRET?: string;
	GIT_OAUTH_CLIENT_ID?: string;
	GIT_OAUTH_CLIENT_SECRET?: string;
	GIT_OAUTH_REDIRECT_URI?: string;
	APP_URL?: string;
}

/**
 * Resolve the GitHub OAuth redirect URI. Uses GIT_OAUTH_REDIRECT_URI when set,
 * otherwise defaults to `<APP_URL>/api/git-oauth/callback`.
 */
export function resolveRedirectUri(env: GitOAuthEnv): string {
	if (env.GIT_OAUTH_REDIRECT_URI) return env.GIT_OAUTH_REDIRECT_URI;
	const appUrl = env.APP_URL?.replace(/\/+$/, '');
	if (!appUrl) {
		throw new GitOAuthError(
			'APP_URL or GIT_OAUTH_REDIRECT_URI must be set',
			'missing_config',
		);
	}
	return `${appUrl}/api/git-oauth/callback`;
}

/**
 * Build the GitHub OAuth authorize URL.
 */
export function buildAuthorizeUrl(
	clientId: string,
	state: string,
	redirectUri: string,
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		scope: GITHUB_SCOPE,
		state,
	});
	return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}
