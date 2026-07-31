/**
 * Tests for the digital signature library (ADA-684).
 *
 * All tests use real WebCrypto (Node 19+ or browser). Tests are skipped
 * in environments without crypto.subtle.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SignatureError,
	exportPrivateKey,
	exportPublicKey,
	generateKeyPair,
	importPrivateKey,
	importPublicKey,
	signWithKeyPair,
	verifyWithJwk,
	verifyWithKey,
	type SignatureCrypto,
} from '../signature.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if real WebCrypto is available (Node 19+ or browser). */
function hasRealCrypto(): boolean {
	return typeof crypto !== 'undefined' && !!crypto.subtle;
}

/** Create a fresh ECDSA P-256 key pair via real WebCrypto. */
async function realKeyPair(): Promise<{
	privateKey: CryptoKey;
	publicKey: CryptoKey;
}> {
	return generateKeyPair(undefined as unknown as SignatureCrypto, true);
}

// ---------------------------------------------------------------------------
// signWithKeyPair + verifyWithKey (real crypto)
// ---------------------------------------------------------------------------

describe('signWithKeyPair and verifyWithKey (real crypto)', () => {
	const itReal = hasRealCrypto() ? it : it.skip;

	itReal('signs a string payload and verifies it', async () => {
		const kp = await realKeyPair();
		const result = await signWithKeyPair('hello world', kp);
		expect(result.signature).toBeTypeOf('string');
		expect(result.signature.length).toBeGreaterThan(0);
		expect(result.publicKeyJwk.kty).toBe('EC');
		expect(result.publicKeyJwk.crv).toBe('P-256');

		const v = await verifyWithKey(
			'hello world',
			result.signature,
			kp.publicKey,
		);
		expect(v.valid).toBe(true);
	});

	itReal('signs an object payload and verifies it', async () => {
		const kp = await realKeyPair();
		const payload = { user: 'alice', hours: 40, exported: '2026-07-31' };
		const result = await signWithKeyPair(payload, kp);

		const v = await verifyWithKey(payload, result.signature, kp.publicKey);
		expect(v.valid).toBe(true);
	});

	itReal('rejects a tampered payload', async () => {
		const kp = await realKeyPair();
		const result = await signWithKeyPair('original', kp);
		const v = await verifyWithKey('tampered', result.signature, kp.publicKey);
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('Signature does not match payload.');
	});

	itReal('signs a nested object payload and verifies it', async () => {
		const kp = await realKeyPair();
		const payload = {
			user: 'alice',
			entries: [
				{ id: 1, hours: 8, project: 'ALPHA' },
				{ id: 2, hours: 4, project: 'BETA' },
			],
		};
		const result = await signWithKeyPair(payload, kp);

		const v = await verifyWithKey(payload, result.signature, kp.publicKey);
		expect(v.valid).toBe(true);
	});

	itReal('rejects a tampered nested payload (canonicalisation covers nested keys)', async () => {
		const kp = await realKeyPair();
		const original = {
			user: 'alice',
			entries: [
				{ id: 1, hours: 8, project: 'ALPHA' },
			],
		};
		const result = await signWithKeyPair(original, kp);

		// Tamper a nested value — changing hours from 8 to 999
		const tampered = {
			user: 'alice',
			entries: [
				{ id: 1, hours: 999, project: 'ALPHA' },
			],
		};
		const v = await verifyWithKey(tampered, result.signature, kp.publicKey);
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('Signature does not match payload.');
	});

	itReal('rejects a wrong public key', async () => {
		const kp1 = await realKeyPair();
		const kp2 = await realKeyPair();
		const result = await signWithKeyPair('payload', kp1);
		const v = await verifyWithKey('payload', result.signature, kp2.publicKey);
		expect(v.valid).toBe(false);
	});

	itReal('returns valid=false for empty payload', async () => {
		const kp = await realKeyPair();
		const v = await verifyWithKey('', 'some-sig', kp.publicKey);
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('Payload must not be empty.');
	});

	itReal('returns valid=false for empty signature', async () => {
		const kp = await realKeyPair();
		const v = await verifyWithKey('payload', '', kp.publicKey);
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('Signature is required.');
	});

	itReal('returns valid=false for missing public key', async () => {
		const v = await verifyWithKey(
			'payload',
			'sig',
			null as unknown as CryptoKey,
		);
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('Public key is required.');
	});

	itReal('returns valid=false for malformed base64url signature', async () => {
		const kp = await realKeyPair();
		const v = await verifyWithKey(
			'payload',
			'!!!invalid-base64!!!',
			kp.publicKey,
		);
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('Signature is not valid base64url.');
	});
});

// ---------------------------------------------------------------------------
// signWithKeyPair + verifyWithJwk (JWK round-trip)
// ---------------------------------------------------------------------------

describe('verifyWithJwk (JWK round-trip)', () => {
	const itReal = hasRealCrypto() ? it : it.skip;

	itReal('verifies via exported JWK public key', async () => {
		const kp = await realKeyPair();
		const result = await signWithKeyPair('verify-via-jwk', kp);
		const v = await verifyWithJwk(
			'verify-via-jwk',
			result.signature,
			result.publicKeyJwk,
		);
		expect(v.valid).toBe(true);
	});

	itReal('rejects tampered payload via JWK', async () => {
		const kp = await realKeyPair();
		const result = await signWithKeyPair('original', kp);
		const v = await verifyWithJwk(
			'tampered',
			result.signature,
			result.publicKeyJwk,
		);
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('Signature does not match payload.');
	});

	itReal('returns valid=false for null JWK', async () => {
		const v = await verifyWithJwk(
			'payload',
			'sig',
			null as unknown as JsonWebKey,
		);
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('Public key JWK is required.');
	});
});

// ---------------------------------------------------------------------------
// Key export / import
// ---------------------------------------------------------------------------

describe('key export / import', () => {
	const itReal = hasRealCrypto() ? it : it.skip;

	itReal('exports and re-imports a public key', async () => {
		const kp = await realKeyPair();
		const jwk = await exportPublicKey(kp.publicKey);
		expect(jwk.kty).toBe('EC');
		expect(jwk.crv).toBe('P-256');
		expect(jwk.x).toBeTypeOf('string');
		expect(jwk.y).toBeTypeOf('string');
		expect(jwk.d).toBeUndefined(); // public key must not leak private

		const imported = await importPublicKey(jwk);
		const result = await signWithKeyPair('round-trip', kp);
		const v = await verifyWithKey('round-trip', result.signature, imported);
		expect(v.valid).toBe(true);
	});

	itReal('exports and re-imports an extractable private key', async () => {
		const kp = await realKeyPair();
		const jwk = await exportPrivateKey(kp.privateKey);
		expect(jwk.d).toBeTypeOf('string'); // private key includes d

		const importedPrivate = await importPrivateKey(jwk);
		// Re-sign with the re-imported private key
		const result = await signWithKeyPair('imported-priv', {
			privateKey: importedPrivate,
			publicKey: kp.publicKey,
		});
		const v = await verifyWithKey('imported-priv', result.signature, kp.publicKey);
		expect(v.valid).toBe(true);
	});

	itReal('importPrivateKey rejects an invalid JWK', async () => {
		await expect(
			importPrivateKey({ kty: 'EC', crv: 'P-999' } as JsonWebKey),
		).rejects.toThrow(SignatureError);
	});

	itReal('importPublicKey rejects an invalid JWK', async () => {
		await expect(
			importPublicKey({ kty: 'RSA' } as JsonWebKey),
		).rejects.toThrow(SignatureError);
	});
});

// ---------------------------------------------------------------------------
// generateKeyPair
// ---------------------------------------------------------------------------

describe('generateKeyPair', () => {
	const itReal = hasRealCrypto() ? it : it.skip;

	itReal('generates a non-extractable key pair by default', async () => {
		const kp = await generateKeyPair();
		expect(kp.privateKey).toBeDefined();
		expect(kp.publicKey).toBeDefined();
		expect(kp.privateKey.extractable).toBe(false);
	});

	itReal('generates an extractable key pair when requested', async () => {
		const kp = await generateKeyPair(
			undefined as unknown as SignatureCrypto,
			true,
		);
		expect(kp.privateKey.extractable).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// SignatureError
// ---------------------------------------------------------------------------

describe('SignatureError', () => {
	it('has name and code', () => {
		const err = new SignatureError('SIGN_FAILED', 'boom');
		expect(err.name).toBe('SignatureError');
		expect(err.code).toBe('SIGN_FAILED');
		expect(err.message).toBe('boom');
	});

	it('toJSON returns code and message', () => {
		const err = new SignatureError('KEY_MISSING', 'no key');
		expect(err.toJSON()).toEqual({ code: 'KEY_MISSING', message: 'no key' });
	});

	it('SignatureError.wrap preserves existing SignatureError', () => {
		const original = new SignatureError('KEY_MISSING', 'original');
		const wrapped = SignatureError.wrap(original, 'UNKNOWN');
		expect(wrapped).toBe(original);
	});

	it('SignatureError.wrap converts unknown errors', () => {
		const wrapped = SignatureError.wrap('plain string', 'CRYPTO_INTERNAL');
		expect(wrapped.code).toBe('CRYPTO_INTERNAL');
		expect(wrapped.message).toContain('plain string');
	});

	it('SignatureError.wrap converts Error instances', () => {
		const wrapped = SignatureError.wrap(new Error('native'), 'SIGN_FAILED');
		expect(wrapped.code).toBe('SIGN_FAILED');
		expect(wrapped.message).toBe('native');
	});
});

// ---------------------------------------------------------------------------
// signWithKeyPair — error paths
// ---------------------------------------------------------------------------

describe('signWithKeyPair error paths', () => {
	it('throws KEY_MISSING when private key is null', async () => {
		await expect(
			signWithKeyPair('payload', {
				privateKey: null as unknown as CryptoKey,
				publicKey: {} as CryptoKey,
			}),
		).rejects.toThrow('Private key is required.');
	});

	it('throws KEY_MISSING when public key is null', async () => {
		await expect(
			signWithKeyPair('payload', {
				privateKey: {} as CryptoKey,
				publicKey: null as unknown as CryptoKey,
			}),
		).rejects.toThrow('Public key is required for export.');
	});

	it('throws on empty string payload', async () => {
		const badCrypto: SignatureCrypto = {
			getRandomValues: vi.fn(),
			subtle: {
				generateKey: vi.fn(),
				importKey: vi.fn(),
				exportKey: vi.fn(),
				sign: vi.fn(),
				verify: vi.fn(),
			},
		};
		await expect(
			signWithKeyPair('', {
				privateKey: {} as CryptoKey,
				publicKey: {} as CryptoKey,
			}, badCrypto),
		).rejects.toThrow('Payload must not be empty.');
	});
});
