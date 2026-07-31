/**
 * Tests for the in-memory key manager with rotation + versioning (ADA-707).
 *
 * Like `aesCrypto.test.ts`, these run against Node's real WebCrypto, so they
 * exercise the actual cipher, not a mock. PBKDF2 iterations are lowered for
 * speed. The focus here is the layer `AesCipher` doesn't provide: version
 * stamps, rotation, retired-key retention/eviction, and version-scoped AAD
 * binding.
 */

import { describe, expect, it } from 'vitest';
import {
	KeyManager,
	makeKeyManager,
	type KeyManagerOptions,
} from '../keyManager.js';

const KEY_1 = 'test-secret-one-aaaa';
const KEY_2 = 'test-secret-two-bbbb';
const KEY_3 = 'test-secret-three-cccc';
const KEY_4 = 'test-secret-four-dddd';

/** Fast manager for most tests — 1k PBKDF2 iterations instead of 600k. */
function fastManager(
	secrets: string | string[],
	options: KeyManagerOptions = {},
): KeyManager {
	return new KeyManager(secrets, { iterations: 1_000, ...options });
}

describe('keyManager', () => {
	it('round-trips plaintext through encrypt/decrypt', async () => {
		const km = fastManager(KEY_1);
		const payload = await km.encrypt('jira_api:ATATT3xFfGF0secret');
		await expect(km.decrypt(payload)).resolves.toBe(
			'jira_api:ATATT3xFfGF0secret',
		);
	});

	it('round-trips unicode and long values', async () => {
		const km = fastManager(KEY_1);
		const value = `→ 🚀 日本語 𝄞 ${'x'.repeat(5_000)} — end`;
		const payload = await km.encrypt(value);
		await expect(km.decrypt(payload)).resolves.toBe(value);
	});

	it('stamps the current key version into a self-describing payload', async () => {
		const km = fastManager([KEY_1, KEY_2]);
		const payload = await km.encrypt('versioned');
		expect(payload.startsWith('keymanager:1:2:aes256gcm:')).toBe(true);
		await km.rotate(KEY_3);
		const next = await km.encrypt('versioned-again');
		expect(next.startsWith('keymanager:1:3:aes256gcm:')).toBe(true);
	});

	it('makes the last listed secret the current (encrypting) key', async () => {
		const km = fastManager([KEY_1, KEY_2]);
		expect(km.currentVersion).toBe(2);
		expect(km.versions).toEqual([1, 2]);
	});

	it('accepts a single string shorthand for one secret', async () => {
		const km = fastManager(KEY_1);
		expect(km.currentVersion).toBe(1);
		const payload = await km.encrypt('shorthand');
		await expect(km.decrypt(payload)).resolves.toBe('shorthand');
	});

	it('keeps retired versions readable after rotation', async () => {
		const km = fastManager(KEY_1);
		const oldPayload = await km.encrypt('before-rotation');
		km.rotate(KEY_2);
		expect(km.currentVersion).toBe(2);
		expect(km.status().retiredVersions).toEqual([1]);
		await expect(km.decrypt(oldPayload)).resolves.toBe('before-rotation');
	});

	it('reports a status snapshot with versions but no key material', async () => {
		const km = fastManager([KEY_1, KEY_2]);
		expect(km.status()).toEqual({
			currentVersion: 2,
			versions: [1, 2],
			retiredVersions: [1],
		});
	});

	it('decrypts across instances sharing the same material and ordering', async () => {
		const payload = await fastManager([KEY_1, KEY_2]).encrypt('cross-instance');
		await expect(fastManager([KEY_1, KEY_2]).decrypt(payload)).resolves.toBe(
			'cross-instance',
		);
	});

	it('resumes the grace period after a restart that lists rotated secrets', async () => {
		const first = fastManager(KEY_1);
		first.rotate(KEY_2);
		const payload = await first.encrypt('rotated-data');
		// Restart with the same material in the same order: the rotated key is
		// now retired-but-readable rather than current.
		const restarted = fastManager([KEY_1, KEY_2]);
		expect(restarted.currentVersion).toBe(2);
		await expect(restarted.decrypt(payload)).resolves.toBe('rotated-data');
	});

	it('is order-sensitive across instances (version = position)', async () => {
		const km = fastManager([KEY_1, KEY_2]);
		const payload = await km.encrypt('position-bound');
		// Same material, swapped order → version 2 is now a different secret.
		const swapped = fastManager([KEY_2, KEY_1]);
		await expect(swapped.decrypt(payload)).rejects.toThrow(
			'authentication failed',
		);
	});

	it('evicts the oldest retired keys beyond maxRetiredKeys', async () => {
		const km = fastManager(KEY_1);
		const v1Payload = await km.encrypt('v1-data');
		km.rotate(KEY_2);
		const v2Payload = await km.encrypt('v2-data');
		km.rotate(KEY_3);
		expect(km.status().versions).toEqual([1, 2, 3]);
		km.rotate(KEY_4); // retired set exceeds default maxRetiredKeys (2)
		expect(km.status().versions).toEqual([2, 3, 4]);
		await expect(km.decrypt(v1Payload)).rejects.toThrow(
			'unknown key version 1',
		);
		await expect(km.decrypt(v2Payload)).resolves.toBe('v2-data');
	});

	it('keeps every retired version when maxRetiredKeys is Infinity', async () => {
		const km = fastManager(KEY_1, { maxRetiredKeys: Infinity });
		const v1Payload = await km.encrypt('v1-data');
		km.rotate(KEY_2);
		km.rotate(KEY_3);
		km.rotate(KEY_4);
		expect(km.status().versions).toEqual([1, 2, 3, 4]);
		await expect(km.decrypt(v1Payload)).resolves.toBe('v1-data');
	});

	it('binds each version to its own AAD context (stamp relabel fails)', async () => {
		const km = fastManager([KEY_1, KEY_2]);
		const payload = await km.encrypt('version-bound');
		const relabelled = payload.replace('keymanager:1:2:', 'keymanager:1:1:');
		await expect(km.decrypt(relabelled)).rejects.toThrow(
			'authentication failed',
		);
	});

	it('rejects payloads whose stamped version is not held by the ring', async () => {
		const km = fastManager([KEY_1, KEY_2]);
		const payload = await km.encrypt('gone');
		const relabelled = payload.replace('keymanager:1:2:', 'keymanager:1:9:');
		await expect(km.decrypt(relabelled)).rejects.toThrow(
			'unknown key version 9',
		);
	});

	it('rejects payloads without the keymanager: prefix', async () => {
		const km = fastManager(KEY_1);
		await expect(km.decrypt('aes256gcm:AAAA')).rejects.toThrow(
			'payload must start with "keymanager:"',
		);
	});

	it('rejects unsupported format versions', async () => {
		const km = fastManager(KEY_1);
		await expect(km.decrypt('keymanager:99:1:aes256gcm:AAAA')).rejects.toThrow(
			'unsupported key manager format version 99',
		);
	});

	it('rejects invalid key version stamps', async () => {
		const km = fastManager(KEY_1);
		await expect(km.decrypt('keymanager:1:abc:aes256gcm:AAAA')).rejects.toThrow(
			'invalid key version stamp',
		);
		await expect(km.decrypt('keymanager:1:0:aes256gcm:AAAA')).rejects.toThrow(
			'invalid key version stamp',
		);
	});

	it('rejects payloads with no ciphertext', async () => {
		const km = fastManager(KEY_1);
		await expect(km.decrypt('keymanager:1:1:')).rejects.toThrow(
			'no ciphertext',
		);
		await expect(km.decrypt('keymanager:1:1')).rejects.toThrow('no ciphertext');
	});

	it('rejects an empty secret list at construction', () => {
		expect(() => new KeyManager([])).toThrow('at least one encryption secret');
	});

	it('rejects empty secrets at construction', () => {
		expect(() => new KeyManager('')).toThrow('non-empty strings');
		expect(() => makeKeyManager('')).toThrow('non-empty strings');
	});

	it('rejects duplicate secrets at construction', () => {
		expect(() => new KeyManager([KEY_1, KEY_2, KEY_1])).toThrow(
			'must be unique',
		);
	});

	it('rejects empty new secrets on rotate', () => {
		const km = fastManager(KEY_1);
		expect(() => km.rotate('')).toThrow('non-empty string');
	});

	it('rejects rotating to material already held by the ring', () => {
		const km = fastManager([KEY_1, KEY_2]);
		expect(() => km.rotate(KEY_1)).toThrow(
			'must differ from every secret already held',
		);
		expect(() => km.rotate(KEY_2)).toThrow(
			'must differ from every secret already held',
		);
	});

	it('mints monotonically increasing versions across rotations', async () => {
		const km = fastManager(KEY_1);
		expect(km.rotate(KEY_2)).toBe(2);
		expect(km.rotate(KEY_3)).toBe(3);
		expect(km.rotate(KEY_4)).toBe(4);
		const payload = await km.encrypt('monotonic');
		expect(payload.startsWith('keymanager:1:4:')).toBe(true);
	});

	it('scopes versions per-ring so distinct contexts never collide', async () => {
		const a = fastManager(KEY_1, { aad: 'hoursmith:feature-a:v1' });
		const b = fastManager(KEY_1, { aad: 'hoursmith:feature-b:v1' });
		const payload = await a.encrypt('scoped');
		await expect(b.decrypt(payload)).rejects.toThrow('authentication failed');
	});
});
