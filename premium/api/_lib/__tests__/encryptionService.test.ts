/**
 * Tests for the Encryption Service with versioned key management (ADA-705).
 *
 * All tests run against Node's real WebCrypto (the same `crypto.subtle` the
 * module uses in production), so these exercise the actual cipher, not a
 * mock. PBKDF2 iterations are lowered for speed; the production default
 * (600k) is inherited from `AesCipher` and asserted in aesCrypto.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
	type EncryptionKey,
	EncryptionService,
	type EncryptionServiceOptions,
	makeEncryptionService,
} from '../encryptionService.js';

const KEY_A: EncryptionKey = { id: 'v1', secret: 'secret-a-0123456789abcdef' };
const KEY_B: EncryptionKey = { id: 'v2', secret: 'secret-b-0123456789abcdef' };

/** Fast service for most tests — 1k PBKDF2 iterations instead of 600k. */
function fastService(
	keys: EncryptionKey[],
	options: EncryptionServiceOptions = {},
): EncryptionService {
	return new EncryptionService(keys, { iterations: 1_000, ...options });
}

// ---------------------------------------------------------------------------
// Payload surgery helpers
// ---------------------------------------------------------------------------

function splitEnvelope(payload: string): { kid: string; inner: string } {
	const remainder = payload.slice('hsenc:v1:'.length);
	const colon = remainder.indexOf(':');
	return {
		kid: remainder.slice(0, colon),
		inner: remainder.slice(colon + 1),
	};
}

/** Rewrite the key id in an `hsenc:` payload, keeping the inner ciphertext. */
function setKid(payload: string, kid: string): string {
	const { inner } = splitEnvelope(payload);
	return `hsenc:v1:${kid}:${inner}`;
}

/** Flip one byte inside the inner aes256gcm ciphertext (not the tag). */
function tamperInner(payload: string): string {
	const { kid, inner } = splitEnvelope(payload);
	const body = inner.slice('aes256gcm:'.length);
	const bytes = base64ToBytes(body);
	bytes[1 + 16 + 12 + 2] ^= 0xff; // inside ciphertext, not the tag
	return `hsenc:v1:${kid}:aes256gcm:${bytesToBase64(bytes)}`;
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

// ---------------------------------------------------------------------------
// Cipher behaviour
// ---------------------------------------------------------------------------

describe('encryptionService', () => {
	it('round-trips plaintext through encrypt/decrypt', async () => {
		const service = fastService([KEY_A]);
		const payload = await service.encrypt('jira_api:ATATT3xFfGF0secret');
		expect(payload.startsWith('hsenc:')).toBe(true);
		await expect(service.decrypt(payload)).resolves.toBe(
			'jira_api:ATATT3xFfGF0secret',
		);
	});

	it('round-trips unicode and long values', async () => {
		const service = fastService([KEY_A]);
		const value = `→ 🚀 日本語 𝄞 ${'x'.repeat(5_000)} — end`;
		const payload = await service.encrypt(value);
		await expect(service.decrypt(payload)).resolves.toBe(value);
	});

	it('embeds the active key id in the payload', async () => {
		const service = fastService([KEY_A, KEY_B]);
		const payload = await service.encrypt('hello');
		expect(payload.startsWith('hsenc:v1:v1:aes256gcm:')).toBe(true);
		expect(splitEnvelope(payload).kid).toBe('v1');
	});

	it('is non-deterministic — same plaintext encrypts differently each call', async () => {
		const service = fastService([KEY_A]);
		const a = await service.encrypt('same-input');
		const b = await service.encrypt('same-input');
		expect(a).not.toBe(b);
	});

	it('decrypts across instances sharing the same key', async () => {
		const payload = await fastService([KEY_A]).encrypt('cross-instance');
		await expect(fastService([KEY_A]).decrypt(payload)).resolves.toBe(
			'cross-instance',
		);
	});

	it('fails closed with the wrong secret under the same key id', async () => {
		const payload = await fastService([KEY_A]).encrypt('secret-value');
		const impostor = fastService([
			{ id: 'v1', secret: 'wrong-secret-000000000' },
		]);
		await expect(impostor.decrypt(payload)).rejects.toThrow(
			'authentication failed',
		);
	});

	it('detects a tampered ciphertext (GCM tag)', async () => {
		const payload = await fastService([KEY_A]).encrypt('do-not-modify');
		await expect(
			fastService([KEY_A]).decrypt(tamperInner(payload)),
		).rejects.toThrow('authentication failed');
	});

	it('rejects a rewritten key id pointing at a different known key', async () => {
		// The ciphertext was bound to v1's secret; re-labelling it as v2 must
		// fail GCM authentication, never decrypt with the wrong key.
		const payload = await fastService([KEY_A]).encrypt('kid-swap');
		const forged = setKid(payload, 'v2');
		await expect(fastService([KEY_A, KEY_B]).decrypt(forged)).rejects.toThrow(
			'authentication failed',
		);
	});

	it('fails closed on an unknown key id', async () => {
		const payload = await fastService([KEY_A]).encrypt('rotated?');
		const forged = setKid(payload, 'v99');
		await expect(fastService([KEY_A]).decrypt(forged)).rejects.toThrow(
			'unknown key id "v99"',
		);
	});

	it('respects the activeKeyId option for new ciphertext', async () => {
		const service = fastService([KEY_A, KEY_B], { activeKeyId: 'v2' });
		const payload = await service.encrypt('active-pick');
		expect(splitEnvelope(payload).kid).toBe('v2');
		await expect(service.decrypt(payload)).resolves.toBe('active-pick');
	});

	it('still decrypts legacy payloads when a different key is active', async () => {
		const oldPayload = await fastService([KEY_A]).encrypt('from-v1-era');
		const rotated = fastService([KEY_B, KEY_A], { activeKeyId: 'v2' });
		await expect(rotated.decrypt(oldPayload)).resolves.toBe('from-v1-era');
	});

	it('exposes activeKeyId, listKeyIds and hasKey', () => {
		const service = fastService([KEY_A, KEY_B], { activeKeyId: 'v2' });
		expect(service.activeKeyId).toBe('v2');
		expect(service.listKeyIds()).toEqual(['v1', 'v2']);
		expect(service.hasKey('v1')).toBe(true);
		expect(service.hasKey('v99')).toBe(false);
	});

	it('passes the AAD context through to AesCipher', async () => {
		const opts = { aad: 'hoursmith:export-tokens:v2' };
		const payload = await fastService([KEY_A], opts).encrypt('aad-bound');
		await expect(fastService([KEY_A], opts).decrypt(payload)).resolves.toBe(
			'aad-bound',
		);
		await expect(fastService([KEY_A]).decrypt(payload)).rejects.toThrow(
			'authentication failed',
		);
	});

	it('rejects payloads without the hsenc: prefix', async () => {
		const service = fastService([KEY_A]);
		await expect(service.decrypt('not-an-hsenc-payload')).rejects.toThrow(
			'payload must start with "hsenc:"',
		);
	});

	it('rejects payloads with an unsupported envelope version', async () => {
		const service = fastService([KEY_A]);
		const payload = await service.encrypt('version-check');
		await expect(
			service.decrypt(payload.replace('hsenc:v1:', 'hsenc:v2:')),
		).rejects.toThrow('unsupported payload version "v2"');
	});

	it('rejects payloads missing the key id', async () => {
		const service = fastService([KEY_A]);
		await expect(service.decrypt('hsenc:v1:')).rejects.toThrow(
			'payload is missing the key id',
		);
		// "aes256gcm" is a well-formed kid that isn't in the ring — fails
		// closed as unknown, never parsed as plaintext.
		await expect(service.decrypt('hsenc:v1:aes256gcm:abc')).rejects.toThrow(
			'unknown key id "aes256gcm"',
		);
		// A kid with characters outside the allowed set is rejected outright.
		await expect(
			service.decrypt('hsenc:v1:bad kid!:aes256gcm:abc'),
		).rejects.toThrow('malformed key id');
	});

	it('rejects a truncated inner payload', async () => {
		const service = fastService([KEY_A]);
		const payload = await service.encrypt('truncate-me');
		const { kid } = splitEnvelope(payload);
		// Keep only the prefix + a few bytes of the inner envelope.
		await expect(
			service.decrypt(`hsenc:v1:${kid}:aes256gcm:AAAA`),
		).rejects.toThrow('truncated');
	});
});

// ---------------------------------------------------------------------------
// Construction validation
// ---------------------------------------------------------------------------

describe('encryptionService construction', () => {
	it('rejects an empty key ring', () => {
		expect(() => fastService([])).toThrow('at least one encryption key');
	});

	it('rejects duplicate key ids', () => {
		expect(() => fastService([KEY_A, KEY_A])).toThrow('duplicate key id "v1"');
	});

	it('rejects an empty secret', () => {
		expect(() => fastService([{ id: 'v1', secret: '' }])).toThrow(
			'non-empty string',
		);
	});

	it('rejects invalid key id characters', () => {
		expect(() =>
			fastService([{ id: 'bad kid/with spaces', secret: 'secret-x' }]),
		).toThrow('invalid key id');
	});

	it('rejects an activeKeyId that is not in the ring', () => {
		expect(() => fastService([KEY_A], { activeKeyId: 'nope' })).toThrow(
			'activeKeyId "nope" is not in the key ring',
		);
	});
});

// ---------------------------------------------------------------------------
// Env-driven factory
// ---------------------------------------------------------------------------

describe('makeEncryptionService', () => {
	it('builds a service from TOKEN_ENCRYPTION_SECRET with the default key id', async () => {
		const service = makeEncryptionService(
			{ TOKEN_ENCRYPTION_SECRET: KEY_A.secret },
			{ iterations: 1_000 },
		);
		expect(service.activeKeyId).toBe('current');
		const payload = await service.encrypt('env-roundtrip');
		expect(payload.startsWith('hsenc:v1:current:aes256gcm:')).toBe(true);
		await expect(service.decrypt(payload)).resolves.toBe('env-roundtrip');
	});

	it('honours TOKEN_ENCRYPTION_KEY_ID', async () => {
		const service = makeEncryptionService(
			{ TOKEN_ENCRYPTION_SECRET: KEY_A.secret, TOKEN_ENCRYPTION_KEY_ID: 'v7' },
			{ iterations: 1_000 },
		);
		expect(service.activeKeyId).toBe('v7');
		const payload = await service.encrypt('custom-id');
		expect(payload.startsWith('hsenc:v1:v7:')).toBe(true);
	});

	it('decrypts legacy payloads via TOKEN_ENCRYPTION_LEGACY_KEYS', async () => {
		// Payload written before the rotation, under kid "current".
		const legacyPayload = await fastService([
			{ id: 'current', secret: KEY_A.secret },
		]).encrypt('pre-rotation');
		// After rotating: new secret is active, old secret lives in legacy.
		const service = makeEncryptionService(
			{
				TOKEN_ENCRYPTION_SECRET: KEY_B.secret,
				TOKEN_ENCRYPTION_KEY_ID: 'v2',
				TOKEN_ENCRYPTION_LEGACY_KEYS: JSON.stringify({
					current: KEY_A.secret,
				}),
			},
			{ iterations: 1_000 },
		);
		await expect(service.decrypt(legacyPayload)).resolves.toBe('pre-rotation');
		const fresh = await service.encrypt('post-rotation');
		expect(fresh.startsWith('hsenc:v1:v2:')).toBe(true);
	});

	it('fails loudly when TOKEN_ENCRYPTION_SECRET is missing', () => {
		expect(() => makeEncryptionService({})).toThrow(
			'TOKEN_ENCRYPTION_SECRET must be set',
		);
	});

	it('rejects malformed TOKEN_ENCRYPTION_LEGACY_KEYS JSON', () => {
		expect(() =>
			makeEncryptionService({
				TOKEN_ENCRYPTION_SECRET: KEY_A.secret,
				TOKEN_ENCRYPTION_LEGACY_KEYS: 'not-json',
			}),
		).toThrow('not valid JSON');
	});

	it('rejects a non-object TOKEN_ENCRYPTION_LEGACY_KEYS value', () => {
		expect(() =>
			makeEncryptionService({
				TOKEN_ENCRYPTION_SECRET: KEY_A.secret,
				TOKEN_ENCRYPTION_LEGACY_KEYS: '["not","a","map"]',
			}),
		).toThrow('JSON object mapping key ids to secrets');
	});

	it('rejects legacy ids that collide with the active key id', () => {
		expect(() =>
			makeEncryptionService({
				TOKEN_ENCRYPTION_SECRET: KEY_A.secret,
				TOKEN_ENCRYPTION_LEGACY_KEYS: JSON.stringify({
					current: KEY_B.secret,
				}),
			}),
		).toThrow('collides with the active key id');
	});

	it('rejects legacy keys with an empty secret', () => {
		expect(() =>
			makeEncryptionService({
				TOKEN_ENCRYPTION_SECRET: KEY_A.secret,
				TOKEN_ENCRYPTION_LEGACY_KEYS: JSON.stringify({ v1: '' }),
			}),
		).toThrow('empty secret');
	});

	it('rejects legacy keys with an invalid id', () => {
		expect(() =>
			makeEncryptionService({
				TOKEN_ENCRYPTION_SECRET: KEY_A.secret,
				TOKEN_ENCRYPTION_LEGACY_KEYS: JSON.stringify({
					'bad id!': KEY_B.secret,
				}),
			}),
		).toThrow('invalid legacy key id');
	});

	it('rejects an invalid TOKEN_ENCRYPTION_KEY_ID', () => {
		expect(() =>
			makeEncryptionService({
				TOKEN_ENCRYPTION_SECRET: KEY_A.secret,
				TOKEN_ENCRYPTION_KEY_ID: 'bad id!',
			}),
		).toThrow('invalid TOKEN_ENCRYPTION_KEY_ID');
	});
});
