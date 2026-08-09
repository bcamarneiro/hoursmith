/**
 * Cryptographic utility for signing and verifying refresh tokens (ADA-629).
 *
 * Produces a compact signed token (JWT-adjacent format) using HMAC-SHA256:
 *   `base64url(header).base64url(payload).base64url(signature)`
 *
 * The header is a minimal `{"alg":"HS256","typ":"refresh+jwt"}` so callers
 * can distinguish these from standard Supabase access tokens when both travel
 * through the same middleware. The payload carries the claims the server needs
 * to authorise a new access token without a DB round-trip.
 *
 * Key validation is built in: secrets must be at least 32 bytes and contain
 * at least two character classes (upper, lower, digit, symbol) — strong
 * enough for HMAC-SHA256 and a guard against accidental short/trivial values.
 *
 * Edge-runtime compatible: WebCrypto only, no Node-specific deps. Mirroring
 * the patterns in auth.ts (JWT verification) and polarClient.ts (HMAC verify).
 *
 * Linear: ADA-629.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RefreshTokenPayload {
	/** User ID (sub). */
	sub: string;
	/** Issued-at timestamp (Unix seconds). Auto-set when omitted. */
	iat?: number;
	/** Expiration timestamp (Unix seconds). Required for bounded validity. */
	exp?: number;
	/** Unique token id (prevays replay across rotate cycles). */
	jti?: string;
	/** Monotonic version counter, bumped on each rotate so old tokens are
	 *  rejected even within their expiry window. Callers are responsible for
	 *  persisting the latest version and comparing. */
	tokenVersion?: number;
	/** Arbitrary extra claims callers may attach (e.g. scope, tenant). */
	[key: string]: unknown;
}

export interface SecureTokenHeader {
	alg: string;
	typ: string;
}

export interface KeyValidationResult {
	valid: boolean;
	reason?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Minimum key length in bytes (256 bits) enforced by validateSecretKey. */
export const MIN_KEY_BYTES = 32;

/** The HMAC algorithm we use for signing. */
const HMAC_ALG = 'HS256';

/** Token type marker so consumers can distinguish these from Supabase JWTs. */
const TOKEN_TYPE = 'refresh+jwt';

// ─── Key validation ──────────────────────────────────────────────────────────

const UPPER = /[A-Z]/;
const LOWER = /[a-z]/;
const DIGIT = /[0-9]/;
const SYMBOL = /[^A-Za-z0-9]/;

/**
 * Validate a secret key meets minimum security requirements for HMAC-SHA256
 * signing. Rejects keys shorter than {@link MIN_KEY_BYTES} bytes (256 bits)
 * or keys drawn from fewer than two character classes — a guard against
 * accidentally passing a short user-typed word rather than a generated secret.
 *
 * @returns `{ valid: true }` on pass, `{ valid: false, reason }` on failure.
 */
export function validateSecretKey(secret: string): KeyValidationResult {
	if (typeof secret !== 'string' || secret.length === 0) {
		return { valid: false, reason: 'secret must be a non-empty string' };
	}

	const bytes = new TextEncoder().encode(secret);
	if (bytes.length < MIN_KEY_BYTES) {
		return {
			valid: false,
			reason: `secret must be at least ${MIN_KEY_BYTES} bytes (got ${bytes.length})`,
		};
	}

	let classes = 0;
	if (UPPER.test(secret)) classes++;
	if (LOWER.test(secret)) classes++;
	if (DIGIT.test(secret)) classes++;
	if (SYMBOL.test(secret)) classes++;

	if (classes < 2) {
		return {
			valid: false,
			reason:
				'secret must contain at least 2 character classes (upper, lower, digit, symbol)',
		};
	}

	return { valid: true };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Uint8Array {
	const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function utf8Encode(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function jsonToBase64Url(obj: unknown): string {
	return base64UrlEncode(utf8Encode(JSON.stringify(obj)));
}

// ─── Signing ─────────────────────────────────────────────────────────────────

/**
 * Derive an HMAC-SHA256 CryptoKey from a raw secret string.
 * The caller must have validated the key via {@link validateSecretKey} first;
 * we still handle import failures gracefully by throwing.
 */
async function importHmacKey(
	secret: string,
	usages: KeyUsage[],
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		utf8Encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		usages,
	);
}

/**
 * Sign a refresh-token payload with the given secret and return a compact
 * signed token string.
 *
 * The secret is validated via {@link validateSecretKey} before signing.
 * If the key is too short or low-entropy, the function throws with a
 * descriptive message — callers should treat this as a configuration error.
 *
 * @param payload  Claims to embed. `iat` is auto-set to `Math.floor(Date.now()/1000)`
 *                 when omitted.
 * @param secret   HMAC-SHA256 key (must pass {@link validateSecretKey}).
 * @returns        Compact signed token string.
 */
export async function signRefreshToken(
	payload: RefreshTokenPayload,
	secret: string,
): Promise<string> {
	const validation = validateSecretKey(secret);
	if (!validation.valid) {
		throw new Error(`secureToken: invalid secret — ${validation.reason}`);
	}

	const header: SecureTokenHeader = { alg: HMAC_ALG, typ: TOKEN_TYPE };
	const body: RefreshTokenPayload = {
		...payload,
		iat: payload.iat ?? Math.floor(Date.now() / 1000),
	};

	const headerEncoded = jsonToBase64Url(header);
	const bodyEncoded = jsonToBase64Url(body);
	const signingInput = `${headerEncoded}.${bodyEncoded}`;

	const key = await importHmacKey(secret, ['sign']);
	const sigBuffer = await crypto.subtle.sign('HMAC', key, utf8Encode(signingInput));
	const sigEncoded = base64UrlEncode(new Uint8Array(sigBuffer));

	return `${signingInput}.${sigEncoded}`;
}

/**
 * Verify a signed refresh token and return its payload, or null if the
 * signature is invalid, the format is malformed, or the token has expired.
 *
 * This does NOT validate the token against a server-side store (e.g. version
 * number or revocation list) — callers are responsible for that layer.
 *
 * @param token   The signed token string.
 * @param secret  The same HMAC-SHA256 key used at signing time.
 * @returns       The decoded payload, or null on any verification failure.
 */
export async function verifyRefreshToken(
	token: string,
	secret: string,
): Promise<RefreshTokenPayload | null> {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;

		const [headerEncoded, bodyEncoded, sigEncoded] = parts;

		// Decode and validate header
		const headerBytes = base64UrlDecode(headerEncoded);
		const header: SecureTokenHeader = JSON.parse(
			new TextDecoder().decode(headerBytes),
		);
		if (header.alg !== HMAC_ALG || header.typ !== TOKEN_TYPE) return null;

		// Verify the signature
		const key = await importHmacKey(secret, ['verify']);
		const signingInput = `${headerEncoded}.${bodyEncoded}`;
		const sigBytes = base64UrlDecode(sigEncoded);

		const ok = await crypto.subtle.verify(
			'HMAC',
			key,
			sigBytes as BufferSource,
			utf8Encode(signingInput) as BufferSource,
		);
		if (!ok) return null;

		// Decode the payload
		const payloadBytes = base64UrlDecode(bodyEncoded);
		const payload: RefreshTokenPayload = JSON.parse(
			new TextDecoder().decode(payloadBytes),
		);

		// Reject expired tokens (exp is set and in the past)
		if (
			typeof payload.exp === 'number' &&
			payload.exp * 1000 <= Date.now()
		) {
			return null;
		}

		return payload;
	} catch {
		return null;
	}
}
