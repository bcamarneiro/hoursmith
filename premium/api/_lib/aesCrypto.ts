/**
 * AES-256-GCM symmetric encryption wrapper for Hoursmith Premium (ADA-677).
 *
 * Encrypts third-party API tokens at rest for the `user_tokens` table
 * (ADA-648): `tokenStorage.ts` persists whatever `encrypt()` returns and the
 * plaintext is only derived in-memory at request-forwarding time — never
 * written to the database.
 *
 * Security properties:
 *  - Key derivation: PBKDF2-HMAC-SHA256 with a random 16-byte salt per
 *    encryption and the OWASP-recommended iteration count (600k) for a
 *    256-bit AES key.
 *  - Cipher: AES-256-GCM with a fresh 96-bit IV per encryption. The GCM
 *    authentication tag means tampering is detected, never silently
 *    accepted — a modified byte fails decryption.
 *  - Context binding: every payload is authenticated against a context
 *    string (default `hoursmith:user-tokens:v1`). Ciphertext written under
 *    one context cannot be decrypted under another, so a key shared between
 *    features can't be replayed across them (see `AesCipherOptions.aad`).
 *
 * Payload format (self-describing, `aes256gcm:` prefix):
 *   aes256gcm:<base64(version:u8 | salt:16 | iv:12 | ciphertext | tag:16)>
 *
 * Dependency-free WebCrypto so this stays edge-runtime compatible, mirroring
 * `polarClient.ts` and `tokenStorage.ts`.
 *
 * Linear: ADA-677.
 */

import {
	CryptoDecryptError,
	CryptoKeyError,
	CryptoPayloadError,
} from './cryptoErrors.js';

const PREFIX = 'aes256gcm:';
const FORMAT_VERSION = 1;
const SALT_BYTES = 16;
/** 96-bit IV — the recommended size for AES-GCM. */
const IV_BYTES = 12;
const KEY_BITS = 256;
/** GCM auth tag length appended by WebCrypto. */
const TAG_BYTES = 16;
/** OWASP (2023) recommendation for PBKDF2-HMAC-SHA256. */
const DEFAULT_PBKDF2_ITERATIONS = 600_000;
const DEFAULT_AAD = 'hoursmith:user-tokens:v1';

export interface AesCipherOptions {
	/**
	 * PBKDF2-HMAC-SHA256 iteration count. Defaults to the OWASP-recommended
	 * 600_000. Tests pass a lower count to stay fast; production deployments
	 * should keep the default.
	 */
	iterations?: number;
	/**
	 * AAD context bound into every GCM tag. A payload is only readable by a
	 * `decrypt` call that supplies the same context. Defaults to
	 * `hoursmith:user-tokens:v1`.
	 */
	aad?: string;
	/**
	 * Test seam: injectable `SubtleCrypto`. Defaults to
	 * `globalThis.crypto.subtle` (Node 20+ / edge runtimes).
	 */
	subtle?: SubtleCrypto;
}

/**
 * Symmetric AES-256-GCM cipher for at-rest token encryption.
 *
 * `encrypt` returns a self-describing `aes256gcm:` string — the salt, IV,
 * and version travel with the ciphertext, so `decrypt` only needs the
 * original secret. Each call draws a fresh salt and IV; the same plaintext
 * never produces the same ciphertext.
 */
export class AesCipher {
	private readonly secret: string;
	private readonly iterations: number;
	private readonly aadBytes: Uint8Array<ArrayBuffer>;
	private readonly subtle: SubtleCrypto;

	constructor(secret: string, options: AesCipherOptions = {}) {
		if (typeof secret !== 'string' || secret.length === 0) {
			throw new CryptoKeyError(
				'aesCrypto: encryption secret must be a non-empty string.',
			);
		}
		this.secret = secret;
		this.iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
		this.aadBytes = utf8ToBytes(options.aad ?? DEFAULT_AAD);
		this.subtle = options.subtle ?? globalThis.crypto.subtle;
	}

	/** Encrypt `plaintext` and return an `aes256gcm:` payload string. */
	async encrypt(plaintext: string): Promise<string> {
		const salt = randomBytes(SALT_BYTES);
		const iv = randomBytes(IV_BYTES);
		const key = await this.deriveKey(salt);
		const ciphertext = new Uint8Array(
			await this.subtle.encrypt(
				{
					name: 'AES-GCM',
					iv,
					additionalData: this.aadBytes,
				},
				key,
				utf8ToBytes(plaintext),
			),
		);
		return PREFIX + bytesToBase64(encodeEnvelope(salt, iv, ciphertext));
	}

	/**
	 * Decrypt an `aes256gcm:` payload produced by `encrypt`.
	 *
	 * Throws on malformed payloads, unsupported versions, a wrong secret, a
	 * mismatched context, or any tampering — the GCM tag makes all of those
	 * indistinguishable and all of them fail closed.
	 */
	async decrypt(payload: string): Promise<string> {
		const { salt, iv, ciphertext } = decodeEnvelope(payload);
		const key = await this.deriveKey(salt);
		let plaintext: ArrayBuffer;
		try {
			plaintext = await this.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv,
					additionalData: this.aadBytes,
				},
				key,
				ciphertext,
			);
		} catch {
			throw new CryptoDecryptError(
				'aesCrypto.decrypt failed: authentication failed (wrong secret, wrong context, or tampered payload).',
			);
		}
		return bytesToUtf8(new Uint8Array(plaintext));
	}

	private async deriveKey(salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
		const baseKey = await this.subtle.importKey(
			'raw',
			utf8ToBytes(this.secret),
			'PBKDF2',
			false,
			['deriveKey'],
		);
		return this.subtle.deriveKey(
			{
				name: 'PBKDF2',
				salt,
				iterations: this.iterations,
				hash: 'SHA-256',
			},
			baseKey,
			{ name: 'AES-GCM', length: KEY_BITS },
			false,
			['encrypt', 'decrypt'],
		);
	}
}

/**
 * Convenience factory mirroring the `make*` helpers in this folder
 * (`makeTokenStorage`, `makeRateLimiter`).
 */
export function makeAesCipher(
	secret: string,
	options?: AesCipherOptions,
): AesCipher {
	return new AesCipher(secret, options);
}

// ---------------------------------------------------------------------------
// Payload encoding
// ---------------------------------------------------------------------------

function encodeEnvelope(
	salt: Uint8Array<ArrayBuffer>,
	iv: Uint8Array<ArrayBuffer>,
	ciphertext: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(1 + SALT_BYTES + IV_BYTES + ciphertext.length);
	out[0] = FORMAT_VERSION;
	out.set(salt, 1);
	out.set(iv, 1 + SALT_BYTES);
	out.set(ciphertext, 1 + SALT_BYTES + IV_BYTES);
	return out;
}

function decodeEnvelope(payload: string): {
	salt: Uint8Array<ArrayBuffer>;
	iv: Uint8Array<ArrayBuffer>;
	ciphertext: Uint8Array<ArrayBuffer>;
} {
	if (!payload.startsWith(PREFIX)) {
		throw new CryptoPayloadError(
			`aesCrypto.decrypt: payload must start with "${PREFIX}".`,
		);
	}
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = base64ToBytes(payload.slice(PREFIX.length));
	} catch {
		throw new CryptoPayloadError('aesCrypto.decrypt: payload is not valid base64.');
	}
	const header = 1 + SALT_BYTES + IV_BYTES;
	if (bytes.length < header + TAG_BYTES) {
		throw new CryptoPayloadError('aesCrypto.decrypt: payload is truncated.');
	}
	if (bytes[0] !== FORMAT_VERSION) {
		throw new CryptoPayloadError(
			`aesCrypto.decrypt: unsupported payload version ${bytes[0]}.`,
		);
	}
	return {
		salt: bytes.slice(1, 1 + SALT_BYTES),
		iv: bytes.slice(1 + SALT_BYTES, header),
		ciphertext: bytes.slice(header),
	};
}

// ---------------------------------------------------------------------------
// Byte helpers (mirror polarClient.ts — kept local so the module stays
// dependency-free and self-contained)
// ---------------------------------------------------------------------------

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	globalThis.crypto.getRandomValues(out);
	return out;
}

function utf8ToBytes(s: string): Uint8Array<ArrayBuffer> {
	const enc = new TextEncoder().encode(s);
	const out = new Uint8Array(enc.length);
	out.set(enc);
	return out;
}

function bytesToUtf8(bytes: Uint8Array<ArrayBuffer>): string {
	return new TextDecoder().decode(bytes);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++)
		binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}
