/**
 * Tests for the AES-256-GCM token encryption wrapper (ADA-677).
 *
 * All tests run against Node's real WebCrypto (the same `crypto.subtle` the
 * module uses in production), so these exercise the actual cipher, not a
 * mock. PBKDF2 iterations are lowered for speed; the one test that asserts
 * the production default (600k) exists to keep the default honest.
 */

import { describe, expect, it } from 'vitest';
import { AesCipher, makeAesCipher } from '../aesCrypto.js';
import {
	CryptoDecryptError,
	CryptoKeyError,
	CryptoPayloadError,
} from '../cryptoErrors.js';

const SECRET = 'super-secret-test-key-123';

/** Fast cipher for most tests — 1k PBKDF2 iterations instead of 600k. */
function fastCipher(
	secret = SECRET,
	options: ConstructorParameters<typeof AesCipher>[1] = {},
): AesCipher {
	return new AesCipher(secret, { iterations: 1_000, ...options });
}

/** Flip one byte in the ciphertext region of an `aes256gcm:` payload. */
function tamper(payload: string): string {
	const body = payload.slice('aes256gcm:'.length);
	const bytes = base64ToBytes(body);
	bytes[1 + 16 + 12 + 2] ^= 0xff; // inside ciphertext, not the tag
	return `aes256gcm:${bytesToBase64(bytes)}`;
}

function base64ToBytes(b64: string): Uint8Array {
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

describe('aesCrypto', () => {
	it('round-trips plaintext through encrypt/decrypt', async () => {
		const cipher = fastCipher();
		const payload = await cipher.encrypt('jira_api:ATATT3xFfGF0secret');
		expect(payload.startsWith('aes256gcm:')).toBe(true);
		await expect(cipher.decrypt(payload)).resolves.toBe(
			'jira_api:ATATT3xFfGF0secret',
		);
	});

	it('round-trips unicode and long values', async () => {
		const cipher = fastCipher();
		const value = `→ 🚀 日本語 𝄞 ${'x'.repeat(5_000)} — end`;
		const payload = await cipher.encrypt(value);
		await expect(cipher.decrypt(payload)).resolves.toBe(value);
	});

	it('produces a self-describing payload with salt, iv and GCM tag', async () => {
		const cipher = fastCipher();
		const payload = await cipher.encrypt('hello');
		const bytes = base64ToBytes(payload.slice('aes256gcm:'.length));
		expect(bytes[0]).toBe(1); // format version
		expect(bytes.length).toBeGreaterThanOrEqual(1 + 16 + 12 + 1 + 16);
	});

	it('is non-deterministic — same plaintext encrypts differently each call', async () => {
		const cipher = fastCipher();
		const a = await cipher.encrypt('same-input');
		const b = await cipher.encrypt('same-input');
		expect(a).not.toBe(b);
	});

	it('decrypts across instances sharing the same secret', async () => {
		const payload = await fastCipher().encrypt('cross-instance');
		await expect(fastCipher().decrypt(payload)).resolves.toBe('cross-instance');
	});

	it('fails closed with the wrong secret', async () => {
		const payload = await fastCipher().encrypt('secret-value');
		await expect(
			fastCipher('wrong-secret-key-456').decrypt(payload),
		).rejects.toThrow('authentication failed');
	});

	it('detects a tampered ciphertext (GCM tag)', async () => {
		const payload = await fastCipher().encrypt('do-not-modify');
		await expect(fastCipher().decrypt(tamper(payload))).rejects.toThrow(
			'authentication failed',
		);
	});

	it('rejects payloads with the wrong context (AAD binding)', async () => {
		const payload = await fastCipher().encrypt('context-bound');
		const other = fastCipher(SECRET, { aad: 'some-other-feature:v1' });
		await expect(other.decrypt(payload)).rejects.toThrow(
			'authentication failed',
		);
	});

	it('accepts payloads whose AAD matches', async () => {
		const opts = { aad: 'hoursmith:export-tokens:v2' };
		const payload = await fastCipher(SECRET, opts).encrypt('aad-ok');
		await expect(fastCipher(SECRET, opts).decrypt(payload)).resolves.toBe(
			'aad-ok',
		);
	});

	it('rejects payloads without the aes256gcm: prefix', async () => {
		const cipher = fastCipher();
		await expect(cipher.decrypt('not-an-aes-payload')).rejects.toThrow(
			'payload must start with "aes256gcm:"',
		);
	});

	it('rejects truncated payloads', async () => {
		const cipher = fastCipher();
		const payload = await cipher.encrypt('truncate-me');
		// Keep only the prefix + ~7 bytes of envelope — well under the
		// 45-byte structural minimum (1 version + 16 salt + 12 iv + 16 tag).
		await expect(
			cipher.decrypt(payload.slice(0, 'aes256gcm:'.length + 10)),
		).rejects.toThrow('payload is truncated');
	});

	it('rejects garbage base64', async () => {
		await expect(
			fastCipher().decrypt('aes256gcm:@@not-base64@@'),
		).rejects.toThrow('not valid base64');
	});

	it('rejects unsupported format versions', async () => {
		const cipher = fastCipher();
		const payload = await cipher.encrypt('version-check');
		const bytes = base64ToBytes(payload.slice('aes256gcm:'.length));
		bytes[0] = 99;
		await expect(
			cipher.decrypt(`aes256gcm:${bytesToBase64(bytes)}`),
		).rejects.toThrow('unsupported payload version 99');
	});

	it('rejects an empty encryption secret at construction', () => {
		expect(() => new AesCipher('')).toThrow('non-empty string');
		expect(() => makeAesCipher('')).toThrow('non-empty string');
	});

	it('works with the production default iteration count', async () => {
		const cipher = new AesCipher(SECRET); // 600k PBKDF2 iterations
		const payload = await cipher.encrypt('default-iterations');
		await expect(cipher.decrypt(payload)).resolves.toBe('default-iterations');
	});

	it('throws CryptoKeyError for an empty secret', () => {
		expect(() => new AesCipher('')).toThrow(CryptoKeyError);
	});

	it('throws CryptoDecryptError on GCM authentication failures', async () => {
		const payload = await fastCipher().encrypt('typed-error');
		await expect(
			fastCipher('wrong-secret-key-456').decrypt(payload),
		).rejects.toBeInstanceOf(CryptoDecryptError);
		await expect(fastCipher().decrypt(tamper(payload))).rejects.toBeInstanceOf(
			CryptoDecryptError,
		);
	});

	it('throws CryptoPayloadError on malformed payloads', async () => {
		const cipher = fastCipher();
		await expect(cipher.decrypt('not-an-aes-payload')).rejects.toBeInstanceOf(
			CryptoPayloadError,
		);
		await expect(
			cipher.decrypt('aes256gcm:@@not-base64@@'),
		).rejects.toBeInstanceOf(CryptoPayloadError);
	});

	it('throws CryptoPayloadError on unsupported versions', async () => {
		const cipher = fastCipher();
		const payload = await cipher.encrypt('version-check');
		const bytes = base64ToBytes(payload.slice('aes256gcm:'.length));
		bytes[0] = 99;
		await expect(
			cipher.decrypt(`aes256gcm:${bytesToBase64(bytes)}`),
		).rejects.toBeInstanceOf(CryptoPayloadError);
	});
});
