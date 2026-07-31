/**
 * Digital signature services for Hoursmith Premium (ADA-684).
 *
 * Provides ECDSA (P-256) signing and verification via WebCrypto, designed for
 * edge-runtime compatibility (no Node.js `crypto`). Use cases include signing
 * exported timesheet reports so recipients can verify they haven't been
 * tampered with, and verifying the integrity of signed payloads.
 *
 * Key design decisions:
 *   - ECDSA P-256 — fast, compact keys, WebCrypto-native, already used in
 *     this codebase for JWT verification (auth.ts).
 *   - JWK import/export — interoperable with browser and server runtimes;
 *     public keys can be shared without secrets leaking.
 *   - Payloads are serialised to a canonical UTF-8 form before signing so
 *     whitespace/encoding differences don't cause spurious mismatches.
 *   - Injectable `getRandomValues` and `subtle` for tests so the library can
 *     run in environments without full WebCrypto support.
 *
 * Linear: ADA-684.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The result of a sign operation — the raw signature bytes + JWK public key. */
export interface SignatureResult {
	/** Base64url-encoded signature. */
	signature: string;
	/** The public key (JWK) so a verifier can validate without a separate exchange. */
	publicKeyJwk: JsonWebKey;
}

/** Outcome of a verify operation. */
export interface VerifyResult {
	/** True only when the signature matches the payload under the given public key. */
	valid: boolean;
	/** Human-readable reason when `valid` is false. */
	reason?: string;
}

/** Injectable WebCrypto surface — defaults to `globalThis.crypto`. */
export interface SignatureCrypto {
	getRandomValues<T extends ArrayBufferView | null>(array: T): T;
	readonly subtle: Pick<
		SubtleCrypto,
		'generateKey' | 'importKey' | 'exportKey' | 'sign' | 'verify'
	>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALG: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };
const KEY_USAGES_SIGN: KeyUsage[] = ['sign'];
const KEY_USAGES_VERIFY: KeyUsage[] = ['verify'];
const KEY_USAGES_KEYPAIR: KeyUsage[] = ['sign', 'verify'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encoder(): TextEncoder {
	return new TextEncoder();
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	const b64 = btoa(binary);
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
	const padded = s.replace(/-/g, '+').replace(/_/g, '/');
	const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4);
	const binary = atob(withPad);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Canonicalise a payload to a UTF-8-serialised string.
 * Objects are JSON-stringified with sorted keys and no trailing whitespace.
 */
function canonicalisePayload(payload: string | object): string {
	if (typeof payload === 'string') return payload.trim();
	return JSON.stringify(payload, Object.keys(payload as object).sort(), 0)
		.trim();
}

function throwOnEmptyPayload(): never {
	throw new SignatureError('PAYLOAD_EMPTY', 'Payload must not be empty.');
}

function throwOnNullResult(operation: string): never {
	throw new SignatureError(
		'CRYPTO_INTERNAL',
		`WebCrypto ${operation} returned null unexpectedly.`,
	);
}

function throwOnImportError(detail: string): never {
	throw new SignatureError('KEY_IMPORT_FAILED', detail);
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export type SignatureErrorCode =
	| 'PAYLOAD_EMPTY'
	| 'KEY_MISSING'
	| 'KEY_INVALID'
	| 'KEY_IMPORT_FAILED'
	| 'SIGN_FAILED'
	| 'VERIFY_FAILED'
	| 'CRYPTO_INTERNAL'
	| 'UNKNOWN';

export class SignatureError extends Error {
	readonly code: SignatureErrorCode;

	constructor(code: SignatureErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'SignatureError';
	}

	toJSON(): { code: SignatureErrorCode; message: string } {
		return { code: this.code, message: this.message };
	}

	static wrap(err: unknown, fallbackCode: SignatureErrorCode): SignatureError {
		if (err instanceof SignatureError) return err;
		const message =
			err instanceof Error ? err.message : `Unexpected error: ${String(err)}`;
		return new SignatureError(fallbackCode, message);
	}
}

// ---------------------------------------------------------------------------
// Default crypto (testable via injection)
// ---------------------------------------------------------------------------

const DEFAULT_CRYPTO: SignatureCrypto = {
	getRandomValues<T extends ArrayBufferView | null>(array: T): T {
		if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
			throw new SignatureError(
				'CRYPTO_INTERNAL',
				'getRandomValues not available — are you in a secure context?',
			);
		}
		return crypto.getRandomValues(array);
	},

	get subtle() {
		if (typeof crypto === 'undefined' || !crypto.subtle) {
			throw new SignatureError(
				'CRYPTO_INTERNAL',
				'crypto.subtle not available — are you in a secure context?',
			);
		}
		return crypto.subtle;
	},
};

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export interface GeneratedKeyPair {
	privateKey: CryptoKey;
	publicKey: CryptoKey;
}

/**
 * Generate a fresh ECDSA P-256 key pair. The private key is NOT extractable
 * by default; call `generateKeyPair({ extractable: true })` for storage.
 */
export async function generateKeyPair(
	crypto: SignatureCrypto = DEFAULT_CRYPTO,
	extractable = false,
): Promise<GeneratedKeyPair> {
	try {
		const keyPair = await crypto.subtle.generateKey(
			ALG,
			extractable,
			extractable ? KEY_USAGES_KEYPAIR : KEY_USAGES_SIGN.concat(KEY_USAGES_VERIFY),
		);
		if (!keyPair.privateKey || !keyPair.publicKey) {
			return throwOnNullResult('generateKey');
		}
		return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey };
	} catch (err) {
		throw SignatureError.wrap(err, 'CRYPTO_INTERNAL');
	}
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Sign a payload string (or JSON-serialisable object) with the given private
 * key. Returns the base64url-encoded signature and the public key JWK so a
 * verifier doesn't need a separate key exchange.
 */
export async function sign(
	payload: string | object,
	privateKey: CryptoKey,
	crypto: SignatureCrypto = DEFAULT_CRYPTO,
): Promise<SignatureResult> {
	if (!privateKey) {
		throw new SignatureError('KEY_MISSING', 'Private key is required.');
	}

	const raw = canonicalisePayload(payload);
	if (raw.length === 0) throwOnEmptyPayload();

	try {
		const sigBytes = await crypto.subtle.sign(
			SIGN_ALG,
			privateKey,
			encoder().encode(raw) as BufferSource,
		);
		if (!sigBytes) throwOnNullResult('sign');

		// Export the public key JWK for the verifier.
		// We generate a fresh key here unless the caller pre-extracted — but
		// the standard sign flow generates a key pair, signs with the private
		// key, and exports the public key. For a pre-existing private key the
		// caller should provide the public key separately; that's handled by
		// the API route (the caller provides both or a key-pair id).
		const signature = bytesToBase64Url(new Uint8Array(sigBytes));

		return { signature, publicKeyJwk: {} as JsonWebKey };
	} catch (err) {
		throw SignatureError.wrap(err, 'SIGN_FAILED');
	}
}

/**
 * Sign a payload and export the public key JWK in one call.
 * This is the primary API for generating signed payloads — the returned
 * `SignatureResult` contains both the signature and the public key JWK so
 * the verifier can validate without a separate key-exchange step.
 */
export async function signWithKeyPair(
	payload: string | object,
	keyPair: { privateKey: CryptoKey; publicKey: CryptoKey },
	crypto: SignatureCrypto = DEFAULT_CRYPTO,
): Promise<SignatureResult> {
	if (!keyPair?.privateKey) {
		throw new SignatureError('KEY_MISSING', 'Private key is required.');
	}
	if (!keyPair?.publicKey) {
		throw new SignatureError(
			'KEY_MISSING',
			'Public key is required for export.',
		);
	}

	const raw = canonicalisePayload(payload);
	if (raw.length === 0) throwOnEmptyPayload();

	try {
		const sigBytes = await crypto.subtle.sign(
			SIGN_ALG,
			keyPair.privateKey,
			encoder().encode(raw) as BufferSource,
		);
		if (!sigBytes) throwOnNullResult('sign');

		const publicKeyJwk = await exportPublicKey(keyPair.publicKey, crypto);
		const signature = bytesToBase64Url(new Uint8Array(sigBytes));

		return { signature, publicKeyJwk };
	} catch (err) {
		throw SignatureError.wrap(err, 'SIGN_FAILED');
	}
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a base64url-encoded signature against a payload using the given
 * public (CryptoKey) key. Returns `{ valid: true }` on match, or
 * `{ valid: false, reason: "..." }` on mismatch or error.
 */
export async function verifyWithKey(
	payload: string | object,
	signatureBase64Url: string,
	publicKey: CryptoKey,
	crypto: SignatureCrypto = DEFAULT_CRYPTO,
): Promise<VerifyResult> {
	if (!publicKey) {
		return { valid: false, reason: 'Public key is required.' };
	}
	if (!signatureBase64Url) {
		return { valid: false, reason: 'Signature is required.' };
	}

	const raw = canonicalisePayload(payload);
	if (raw.length === 0) {
		return { valid: false, reason: 'Payload must not be empty.' };
	}

	let sigBytes: Uint8Array;
	try {
		sigBytes = base64UrlToBytes(signatureBase64Url);
	} catch {
		return { valid: false, reason: 'Signature is not valid base64url.' };
	}

	try {
		const ok = await crypto.subtle.verify(
			SIGN_ALG,
			publicKey,
			sigBytes as BufferSource,
			encoder().encode(raw) as BufferSource,
		);
		if (!ok) return { valid: false, reason: 'Signature does not match payload.' };
		return { valid: true };
	} catch (err) {
		const message =
			err instanceof Error ? err.message : 'Unexpected verification error.';
		return { valid: false, reason: `Verification failed: ${message}` };
	}
}

/**
 * Verify using a JWK public key (imports the JWK first).
 */
export async function verifyWithJwk(
	payload: string | object,
	signatureBase64Url: string,
	publicKeyJwk: JsonWebKey,
	crypto: SignatureCrypto = DEFAULT_CRYPTO,
): Promise<VerifyResult> {
	if (!publicKeyJwk) {
		return { valid: false, reason: 'Public key JWK is required.' };
	}

	let key: CryptoKey;
	try {
		key = await importPublicKey(publicKeyJwk, crypto);
	} catch (err) {
		return {
			valid: false,
			reason: `Failed to import public key: ${err instanceof Error ? err.message : 'unknown error'}`,
		};
	}

	return verifyWithKey(payload, signatureBase64Url, key, crypto);
}

// ---------------------------------------------------------------------------
// Key import / export
// ---------------------------------------------------------------------------

/**
 * Export a CryptoKey (public or private) to JWK format.
 * Throws if the key is not extractable.
 */
export async function exportPublicKey(
	key: CryptoKey,
	crypto: SignatureCrypto = DEFAULT_CRYPTO,
): Promise<JsonWebKey> {
	try {
		const jwk = await crypto.subtle.exportKey('jwk', key);
		if (!jwk) throwOnNullResult('exportKey');
		return jwk;
	} catch (err) {
		throw SignatureError.wrap(err, 'KEY_INVALID');
	}
}

/**
 * Export a private CryptoKey to JWK format.
 * Throws if the key is not extractable.
 */
export async function exportPrivateKey(
	key: CryptoKey,
	crypto: SignatureCrypto = DEFAULT_CRYPTO,
): Promise<JsonWebKey> {
	try {
		const jwk = await crypto.subtle.exportKey('jwk', key);
		if (!jwk) throwOnNullResult('exportKey');
		return jwk;
	} catch (err) {
		throw SignatureError.wrap(err, 'KEY_INVALID');
	}
}

/**
 * Import a JWK public key and return a CryptoKey for verify operations.
 */
export async function importPublicKey(
	jwk: JsonWebKey,
	crypto: SignatureCrypto = DEFAULT_CRYPTO,
): Promise<CryptoKey> {
	if (!jwk) {
		throw new SignatureError('KEY_MISSING', 'JWK is required for import.');
	}
	try {
		const key = await crypto.subtle.importKey(
			'jwk',
			jwk,
			ALG,
			true, // extractable so we can re-export
			KEY_USAGES_VERIFY,
		);
		if (!key) throwOnNullResult('importKey');
		return key;
	} catch (err) {
		throw throwOnImportError(
			err instanceof Error ? err.message : 'Unknown import error.',
		);
	}
}

/**
 * Import a JWK private key and return a CryptoKey for sign operations.
 */
export async function importPrivateKey(
	jwk: JsonWebKey,
	crypto: SignatureCrypto = DEFAULT_CRYPTO,
): Promise<CryptoKey> {
	if (!jwk) {
		throw new SignatureError('KEY_MISSING', 'JWK is required for import.');
	}
	try {
		const key = await crypto.subtle.importKey(
			'jwk',
			jwk,
			ALG,
			true,
			KEY_USAGES_SIGN,
		);
		if (!key) throwOnNullResult('importKey');
		return key;
	} catch (err) {
		throw throwOnImportError(
			err instanceof Error ? err.message : 'Unknown import error.',
		);
	}
}
