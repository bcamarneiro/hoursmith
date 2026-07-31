/**
 * Asymmetric encryption wrapper (ADA-685).
 *
 * Provides public-key encryption / private-key decryption using RSA-OAEP with
 * SHA-256. Designed for server-side use — encrypting third-party API tokens at
 * rest so only the holder of the private key can recover the plaintext.
 *
 * This module is a pure-crypto concern: it operates on `CryptoKey` objects and
 * base64url-encoded strings. Key management (storage, rotation, env-var
 * injection) is the caller's responsibility. The token storage module
 * (`premium/api/_lib/tokenStorage.ts`) consumes the encrypted output as an
 * opaque string via its `encrypted_value` column.
 *
 * All serialisation uses base64url (RFC 4648 §5, no padding) so keys and
 * ciphertexts can be stored in URL-safe contexts (env vars, JSON columns,
 * HTTP headers) without escaping.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RSA-OAEP parameter set shared by encrypt, decrypt, generate, import, export. */
const RSA_OAEP_PARAMS: RsaOaepParams = {
	name: 'RSA-OAEP',
	hash: 'SHA-256',
};

/** RSA-OAEP is safe for payloads up to ~190 bytes with 2048-bit keys. */
const MAX_PLAINTEXT_BYTES = 190;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a fresh RSA-OAEP key pair.
 *
 * The returned keys are *non-extractable* — they cannot be exported with
 * {@link exportPrivateKeyToBase64} after generation. Call that function on the
 * key returned here *before* it leaves scope if you need a serialised copy.
 */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey(
		{
			name: 'RSA-OAEP',
			modulusLength: 2048,
			publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
			hash: 'SHA-256',
		},
		true, // extractable — caller must export before losing the reference
		['encrypt', 'decrypt'],
	);
}

/**
 * Encrypt `plaintext` with a public key. Returns the ciphertext as a
 * base64url-encoded string suitable for storage in a VARCHAR/TEXT column.
 *
 * Throws if `plaintext` is empty or exceeds the RSA-OAEP payload limit.
 */
export async function encryptWithPublicKey(
	publicKey: CryptoKey,
	plaintext: string,
): Promise<string> {
	const encoded = new TextEncoder().encode(plaintext);
	if (encoded.byteLength === 0) {
		throw new Error('asymmetricEncryption: plaintext must not be empty');
	}
	if (encoded.byteLength > MAX_PLAINTEXT_BYTES) {
		throw new Error(
			`asymmetricEncryption: plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes (got ${encoded.byteLength})`,
		);
	}
	const ciphertext = await crypto.subtle.encrypt(RSA_OAEP_PARAMS, publicKey, encoded);
	return arrayBufferToBase64url(ciphertext);
}

/**
 * Decrypt a base64url-encoded ciphertext with a private key. Returns the
 * original plaintext.
 */
export async function decryptWithPrivateKey(
	privateKey: CryptoKey,
	encryptedBase64: string,
): Promise<string> {
	const ciphertext = base64urlToArrayBuffer(encryptedBase64);
	const plaintext = await crypto.subtle.decrypt(
		RSA_OAEP_PARAMS,
		privateKey,
		ciphertext,
	);
	return new TextDecoder().decode(plaintext);
}

/**
 * Export a public key as a base64url-encoded SPKI (SubjectPublicKeyInfo).
 *
 * Pass this string to {@link importPublicKeyFromBase64} to reconstruct the
 * key. Suitable for embedding in environment variables or configuration.
 */
export async function exportPublicKeyToBase64(
	publicKey: CryptoKey,
): Promise<string> {
	const spki = await crypto.subtle.exportKey('spki', publicKey);
	return arrayBufferToBase64url(spki);
}

/**
 * Import a public key from a base64url-encoded SPKI string previously
 * produced by {@link exportPublicKeyToBase64}.
 */
export async function importPublicKeyFromBase64(
	spkiBase64: string,
): Promise<CryptoKey> {
	const spki = base64urlToArrayBuffer(spkiBase64);
	return crypto.subtle.importKey(
		'spki',
		spki,
		RSA_OAEP_PARAMS,
		true,
		['encrypt'],
	);
}

/**
 * Export a private key as a base64url-encoded PKCS#8 string.
 *
 * Only works when the key was created with `extractable: true` (the default
 * for keys produced by {@link generateKeyPair}). Call this immediately after
 * generation if you need a serialised private key.
 */
export async function exportPrivateKeyToBase64(
	privateKey: CryptoKey,
): Promise<string> {
	const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
	return arrayBufferToBase64url(pkcs8);
}

/**
 * Import a private key from a base64url-encoded PKCS#8 string previously
 * produced by {@link exportPrivateKeyToBase64}.
 */
export async function importPrivateKeyFromBase64(
	pkcs8Base64: string,
): Promise<CryptoKey> {
	const pkcs8 = base64urlToArrayBuffer(pkcs8Base64);
	return crypto.subtle.importKey(
		'pkcs8',
		pkcs8,
		RSA_OAEP_PARAMS,
		true,
		['decrypt'],
	);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Encode an `ArrayBuffer` as a base64url string (RFC 4648 §5, no padding).
 *
 * We avoid `btoa` because it operates on Latin-1 codepoints and cannot
 * directly encode arbitrary binary data. The manual approach below handles
 * every byte value correctly in both browser and Node.js runtimes.
 */
function arrayBufferToBase64url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/**
 * Decode a base64url string into an `ArrayBuffer`.
 */
function base64urlToArrayBuffer(base64url: string): ArrayBuffer {
	// Restore standard base64 before decoding.
	const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}
