/**
 * Tests for the asymmetric encryption wrapper (ADA-685).
 *
 * Covers the full lifecycle: generate → export → import → encrypt →
 * decrypt → plaintext round-trip, plus error paths and edge cases.
 *
 * These tests use `crypto.subtle` (WebCrypto), which is available in
 * Node.js 19+ and the happy-dom environment configured in vitest.config.ts.
 * No polyfills or mocks needed.
 */

import { describe, expect, it } from 'vitest';
import {
	decryptWithPrivateKey,
	encryptWithPublicKey,
	exportPrivateKeyToBase64,
	exportPublicKeyToBase64,
	generateKeyPair,
	importPrivateKeyFromBase64,
	importPublicKeyFromBase64,
} from '../asymmetricEncryption';

// ---------------------------------------------------------------------------
// Round-trip: full lifecycle
// ---------------------------------------------------------------------------

describe('asymmetricEncryption', () => {
	describe('generateKeyPair', () => {
		it('produces a key pair with public and private keys', async () => {
			const pair = await generateKeyPair();
			expect(pair.publicKey).toBeDefined();
			expect(pair.privateKey).toBeDefined();
			expect(pair.publicKey.type).toBe('public');
			expect(pair.privateKey.type).toBe('private');
			expect(pair.publicKey.algorithm.name).toBe('RSA-OAEP');
		});

		it('produces distinct public and private keys', async () => {
			const a = await generateKeyPair();
			const b = await generateKeyPair();
			// Different key pairs should have different public keys.
			const aSpki = await exportPublicKeyToBase64(a.publicKey);
			const bSpki = await exportPublicKeyToBase64(b.publicKey);
			expect(aSpki).not.toBe(bSpki);
		});
	});

	describe('encryptWithPublicKey / decryptWithPrivateKey', () => {
		it('round-trips a plaintext through encrypt → decrypt', async () => {
			const pair = await generateKeyPair();
			const plaintext = 'sk-test-abc123-def456';
			const encrypted = await encryptWithPublicKey(pair.publicKey, plaintext);
			expect(encrypted).toBeTruthy();
			expect(encrypted).not.toBe(plaintext);
			const decrypted = await decryptWithPrivateKey(pair.privateKey, encrypted);
			expect(decrypted).toBe(plaintext);
		});

		it('handles Unicode plaintext (emoji, non-ASCII)', async () => {
			const pair = await generateKeyPair();
			const plaintext = 'token🔑-café-日本語-מזהה';
			const encrypted = await encryptWithPublicKey(pair.publicKey, plaintext);
			const decrypted = await decryptWithPrivateKey(pair.privateKey, encrypted);
			expect(decrypted).toBe(plaintext);
		});

		it('handles single-character plaintext', async () => {
			const pair = await generateKeyPair();
			const encrypted = await encryptWithPublicKey(pair.publicKey, 'x');
			const decrypted = await decryptWithPrivateKey(pair.privateKey, encrypted);
			expect(decrypted).toBe('x');
		});

		it('handles maximum-length plaintext', async () => {
			const pair = await generateKeyPair();
			// 190 bytes is the max for RSA-OAEP with SHA-256 on a 2048-bit key.
			const plaintext = 'a'.repeat(190);
			const encrypted = await encryptWithPublicKey(pair.publicKey, plaintext);
			const decrypted = await decryptWithPrivateKey(pair.privateKey, encrypted);
			expect(decrypted).toBe(plaintext);
		});

		it('throws when plaintext is empty', async () => {
			const pair = await generateKeyPair();
			await expect(
				encryptWithPublicKey(pair.publicKey, ''),
			).rejects.toThrow('plaintext must not be empty');
		});

		it('throws when plaintext exceeds 190 bytes', async () => {
			const pair = await generateKeyPair();
			const oversized = 'x'.repeat(191);
			await expect(
				encryptWithPublicKey(pair.publicKey, oversized),
			).rejects.toThrow('plaintext exceeds 190 bytes');
		});

		it('produces different ciphertexts for the same plaintext (OAEP non-determinism)', async () => {
			const pair = await generateKeyPair();
			const plaintext = 'same-token-value';
			const c1 = await encryptWithPublicKey(pair.publicKey, plaintext);
			const c2 = await encryptWithPublicKey(pair.publicKey, plaintext);
			expect(c1).not.toBe(c2);
			// Both must decrypt to the original.
			expect(await decryptWithPrivateKey(pair.privateKey, c1)).toBe(plaintext);
			expect(await decryptWithPrivateKey(pair.privateKey, c2)).toBe(plaintext);
		});

		it('different plaintexts produce different ciphertexts', async () => {
			const pair = await generateKeyPair();
			const c1 = await encryptWithPublicKey(pair.publicKey, 'token-alpha');
			const c2 = await encryptWithPublicKey(pair.publicKey, 'token-beta');
			expect(c1).not.toBe(c2);
		});

		it('rejects decryption with a different key pair', async () => {
			const alice = await generateKeyPair();
			const bob = await generateKeyPair();
			const encrypted = await encryptWithPublicKey(alice.publicKey, 'secret');
			// Bob's private key cannot decrypt Alice's ciphertext.
			await expect(
				decryptWithPrivateKey(bob.privateKey, encrypted),
			).rejects.toThrow();
		});

		it('rejects decryption of tampered ciphertext', async () => {
			const pair = await generateKeyPair();
			const encrypted = await encryptWithPublicKey(pair.publicKey, 'secret');
			// Tamper a byte in the middle of the decoded ciphertext so
			// the change always alters a real data byte (flipping the
			// last base64url character is a no-op ~25 % of the time
			// when the character differs only in padding bits).
			const mid = Math.floor(encrypted.length / 2);
			const tampered =
				encrypted.slice(0, mid) +
				(encrypted[mid] === 'A' ? 'B' : 'A') +
				encrypted.slice(mid + 1);
			await expect(
				decryptWithPrivateKey(pair.privateKey, tampered),
			).rejects.toThrow();
		});

		it('rejects decryption of garbage input', async () => {
			const pair = await generateKeyPair();
			await expect(
				decryptWithPrivateKey(pair.privateKey, 'not-valid-base64!!!'),
			).rejects.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// Key export / import round-trips
	// -----------------------------------------------------------------------

	describe('public key export / import (SPKI)', () => {
		it('round-trips: export → import → encrypt → decrypt', async () => {
			const pair = await generateKeyPair();
			const spki = await exportPublicKeyToBase64(pair.publicKey);
			expect(spki).toBeTruthy();
			expect(typeof spki).toBe('string');

			const imported = await importPublicKeyFromBase64(spki);
			const encrypted = await encryptWithPublicKey(imported, 'hello');
			const decrypted = await decryptWithPrivateKey(
				pair.privateKey,
				encrypted,
			);
			expect(decrypted).toBe('hello');
		});

		it('rejects importing garbage SPKI', async () => {
			await expect(
				importPublicKeyFromBase64('not-a-valid-spki-key'),
			).rejects.toThrow();
		});
	});

	describe('private key export / import (PKCS#8)', () => {
		it('round-trips: export → import → decrypt', async () => {
			const pair = await generateKeyPair();
			const pkcs8 = await exportPrivateKeyToBase64(pair.privateKey);
			expect(pkcs8).toBeTruthy();
			expect(typeof pkcs8).toBe('string');

			const imported = await importPrivateKeyFromBase64(pkcs8);
			const encrypted = await encryptWithPublicKey(pair.publicKey, 'hello');
			const decrypted = await decryptWithPrivateKey(imported, encrypted);
			expect(decrypted).toBe('hello');
		});

		it('rejects importing garbage PKCS#8', async () => {
			await expect(
				importPrivateKeyFromBase64('not-a-valid-pkcs8-key'),
			).rejects.toThrow();
		});
	});

	describe('full cross-import round-trip', () => {
		it('encrypts with imported public, decrypts with imported private', async () => {
			const pair = await generateKeyPair();
			const spki = await exportPublicKeyToBase64(pair.publicKey);
			const pkcs8 = await exportPrivateKeyToBase64(pair.privateKey);

			const pub = await importPublicKeyFromBase64(spki);
			const priv = await importPrivateKeyFromBase64(pkcs8);

			const plaintext = 'full-cross-import-test';
			const encrypted = await encryptWithPublicKey(pub, plaintext);
			const decrypted = await decryptWithPrivateKey(priv, encrypted);

			expect(decrypted).toBe(plaintext);
		});
	});

	// -----------------------------------------------------------------------
	// Error messages are descriptive
	// -----------------------------------------------------------------------

	describe('error messages', () => {
		it('empty plaintext error includes "asymmetricEncryption" prefix', async () => {
			const pair = await generateKeyPair();
			await expect(
				encryptWithPublicKey(pair.publicKey, ''),
			).rejects.toThrow('asymmetricEncryption');
		});

		it('oversized plaintext error reports byte count', async () => {
			const pair = await generateKeyPair();
			await expect(
				encryptWithPublicKey(pair.publicKey, 'x'.repeat(191)),
			).rejects.toThrow(/190/);
		});
	});
});
