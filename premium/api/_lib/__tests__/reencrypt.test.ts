/**
 * Tests for the stateless token re-encryption transform (ADA-709).
 *
 * The transform is a pure function over `aes256gcm:` payloads — no storage,
 * no network. These tests pin the two product guarantees: data integrity
 * (the rotated payload decrypts to the exact same plaintext under the new
 * secret, and only under the new secret) and idempotency (re-running the
 * transform on an already-rotated payload is a byte-stable no-op).
 *
 * Like the aesCrypto suite, tests run against Node's real WebCrypto with
 * PBKDF2 iterations lowered for speed; one test keeps the production default
 * (600k) to keep the default honest.
 */

import { describe, expect, it } from 'vitest';
import { AesCipher } from '../aesCrypto.js';
import { reencryptPayload } from '../reencrypt.js';

const OLD_SECRET = 'old-encryption-secret-aaa';
const NEW_SECRET = 'new-encryption-secret-bbb';
const OTHER_SECRET = 'unrelated-secret-ccc';

/** Fast cipher options for tests — 1k PBKDF2 iterations instead of 600k. */
const FAST = { iterations: 1_000 };

function fastCipher(
	secret: string,
	options: ConstructorParameters<typeof AesCipher>[1] = {},
): AesCipher {
	return new AesCipher(secret, { ...FAST, ...options });
}

async function encryptedUnder(
	secret: string,
	plaintext = 'jira_api:ATATT3xFfGF0secret',
): Promise<string> {
	return fastCipher(secret).encrypt(plaintext);
}

function reencryptOpts(
	overrides: Partial<Parameters<typeof reencryptPayload>[1]> = {},
) {
	return {
		fromSecret: OLD_SECRET,
		toSecret: NEW_SECRET,
		fromOptions: FAST,
		toOptions: FAST,
		...overrides,
	};
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

describe('reencryptPayload', () => {
	it('rotates a payload from the previous secret to the current secret', async () => {
		const plaintext = 'jira_api:ATATT3xFfGF0secret';
		const payload = await encryptedUnder(OLD_SECRET, plaintext);

		const rotated = await reencryptPayload(payload, reencryptOpts());

		expect(rotated).not.toBe(payload);
		await expect(fastCipher(NEW_SECRET).decrypt(rotated)).resolves.toBe(
			plaintext,
		);
		// The previous secret can no longer read the rotated payload.
		await expect(fastCipher(OLD_SECRET).decrypt(rotated)).rejects.toThrow(
			'authentication failed',
		);
	});

	it('preserves plaintext exactly — unicode and long values', async () => {
		const value = `→ 🚀 日本語 𝄞 ${'x'.repeat(5_000)} — end`;
		const payload = await encryptedUnder(OLD_SECRET, value);

		const rotated = await reencryptPayload(payload, reencryptOpts());

		await expect(fastCipher(NEW_SECRET).decrypt(rotated)).resolves.toBe(value);
	});

	it('is idempotent — re-running on an already-rotated payload is a no-op', async () => {
		const payload = await encryptedUnder(OLD_SECRET);
		const opts = reencryptOpts();

		const rotated = await reencryptPayload(payload, opts);
		for (let i = 0; i < 3; i++) {
			await expect(reencryptPayload(rotated, opts)).resolves.toBe(rotated);
		}
	});

	it('is a byte-stable no-op when the payload is already under the target secret', async () => {
		const payload = await encryptedUnder(NEW_SECRET);

		await expect(reencryptPayload(payload, reencryptOpts())).resolves.toBe(
			payload,
		);
	});

	it('is a no-op when fromSecret and toSecret are the same', async () => {
		const payload = await encryptedUnder(OLD_SECRET);

		await expect(
			reencryptPayload(payload, reencryptOpts({ toSecret: OLD_SECRET })),
		).resolves.toBe(payload);
	});

	it('fails closed when the payload decrypts under neither secret', async () => {
		const payload = await encryptedUnder(OTHER_SECRET);

		await expect(reencryptPayload(payload, reencryptOpts())).rejects.toThrow(
			'could not be decrypted with either',
		);
	});

	it('fails closed on a tampered payload (GCM tag)', async () => {
		const payload = await encryptedUnder(OLD_SECRET);
		const rotated = await reencryptPayload(payload, reencryptOpts());

		await expect(
			reencryptPayload(tamper(rotated), reencryptOpts()),
		).rejects.toThrow('could not be decrypted with either');
	});

	it('fails closed on a malformed payload', async () => {
		await expect(
			reencryptPayload('not-an-aes-payload', reencryptOpts()),
		).rejects.toThrow('could not be decrypted with either');
	});

	it('honours per-side AAD contexts', async () => {
		const fromOpts = { ...FAST, aad: 'hoursmith:user-tokens:v1' };
		const toOpts = { ...FAST, aad: 'hoursmith:user-tokens:v2' };
		const payload = await fastCipher(OLD_SECRET, fromOpts).encrypt(
			'aad-rotation',
		);

		const rotated = await reencryptPayload(
			payload,
			reencryptOpts({ fromOptions: fromOpts, toOptions: toOpts }),
		);

		await expect(fastCipher(NEW_SECRET, toOpts).decrypt(rotated)).resolves.toBe(
			'aad-rotation',
		);
		// The old AAD context must not read the rotated payload.
		await expect(
			fastCipher(NEW_SECRET, fromOpts).decrypt(rotated),
		).rejects.toThrow('authentication failed');
	});

	it('rejects empty secrets', async () => {
		await expect(
			reencryptPayload('aes256gcm:x', reencryptOpts({ toSecret: '' })),
		).rejects.toThrow('non-empty string');
		await expect(
			reencryptPayload('aes256gcm:x', reencryptOpts({ fromSecret: '' })),
		).rejects.toThrow('non-empty string');
	});

	it('fails closed when fromOptions do not match the payload (PBKDF2 iterations mismatch)', async () => {
		const payload = await encryptedUnder(OLD_SECRET);
		// fromOptions lacks the iterations override → 600k derivation → wrong
		// key → GCM auth failure → fail-closed. This is the most likely first
		// misconfiguration a real rotation job will hit.
		await expect(
			reencryptPayload(payload, reencryptOpts({ fromOptions: {} })),
		).rejects.toThrow('could not be decrypted with either');
	});

	it('works with the production default iteration count', async () => {
		const payload = await new AesCipher(OLD_SECRET).encrypt(
			'default-iterations',
		);

		const rotated = await reencryptPayload(
			payload,
			reencryptOpts({ fromOptions: {}, toOptions: {} }),
		);

		await expect(new AesCipher(NEW_SECRET).decrypt(rotated)).resolves.toBe(
			'default-iterations',
		);
	});
});
