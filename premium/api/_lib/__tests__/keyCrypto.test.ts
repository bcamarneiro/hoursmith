/**
 * Tests for the asymmetric key-pair wrapper (ADA-683).
 *
 * All tests run against Node's real WebCrypto (the same `crypto.subtle` the
 * module uses in production), so these exercise the actual RSA-PSS / ECDSA
 * primitives, not mocks. Key generation is real CSPRNG-backed, so tests
 * asserting uniqueness compare RFC 7638 thumbprints rather than key bytes.
 */

import { describe, expect, it } from 'vitest';
import {
	exportKeyPairPem,
	exportPrivateKeyPem,
	exportPublicKeyJwk,
	exportPublicKeyPem,
	generateKeyPair,
	importKeyPairPem,
	importPrivateKeyPem,
	importPublicKeyJwk,
	importPublicKeyPem,
	publicKeyDescriptor,
	publicKeyThumbprint,
} from '../keyCrypto.js';

const MESSAGE = new TextEncoder().encode('hoursmith-premium-signing-test');

/** Sign `MESSAGE` with the given private key, using its own algorithm family. */
function signWith(pair: CryptoKeyPair): Promise<ArrayBuffer> {
	const name = pair.privateKey.algorithm.name;
	const params =
		name === 'ECDSA'
			? { name: 'ECDSA' as const, hash: 'SHA-256' as const }
			: { name: 'RSA-PSS' as const, saltLength: 32 };
	return globalThis.crypto.subtle.sign(params, pair.privateKey, MESSAGE);
}

function verifyWith(
	pair: CryptoKeyPair,
	signature: ArrayBuffer,
): Promise<boolean> {
	const name = pair.publicKey.algorithm.name;
	const params =
		name === 'ECDSA'
			? { name: 'ECDSA' as const, hash: 'SHA-256' as const }
			: { name: 'RSA-PSS' as const, saltLength: 32 };
	return globalThis.crypto.subtle.verify(params, pair.publicKey, signature, MESSAGE);
}

/** RFC 7638 §3.1 example key — the canonical RSA thumbprint test vector. */
const RFC7638_RSA_JWK = {
	kty: 'RSA',
	n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
	e: 'AQAB',
} as const;

describe('generateKeyPair', () => {
	it('generates a 2048-bit RSA-PSS pair with sign/verify usages', async () => {
		const pair = await generateKeyPair({ algorithm: 'rsa' });
		expect(pair.privateKey.type).toBe('private');
		expect(pair.publicKey.type).toBe('public');
		expect(pair.privateKey.extractable).toBe(true);
		expect(pair.privateKey.algorithm.name).toBe('RSA-PSS');
		expect(pair.publicKey.algorithm.name).toBe('RSA-PSS');
		expect(pair.privateKey.usages).toEqual(['sign']);
		expect(pair.publicKey.usages).toEqual(['verify']);
		const rsaAlgo = pair.privateKey.algorithm as RsaHashedKeyAlgorithm;
		expect(rsaAlgo.modulusLength).toBe(2048);
		expect(rsaAlgo.hash.name).toBe('SHA-256');
	});

	it('generates an ECDSA P-256 pair', async () => {
		const pair = await generateKeyPair({ algorithm: 'ec' });
		expect(pair.privateKey.algorithm.name).toBe('ECDSA');
		expect(pair.publicKey.algorithm.name).toBe('ECDSA');
		const ecAlgo = pair.publicKey.algorithm as EcKeyAlgorithm;
		expect(ecAlgo.namedCurve).toBe('P-256');
	});

	it('defaults to rsa', async () => {
		const pair = await generateKeyPair();
		expect(pair.privateKey.algorithm.name).toBe('RSA-PSS');
	});

	it('is non-deterministic — two generations produce distinct keys', async () => {
		const [a, b] = await Promise.all([
			generateKeyPair({ algorithm: 'rsa' }),
			generateKeyPair({ algorithm: 'rsa' }),
		]);
		expect(await publicKeyThumbprint(a)).not.toBe(
			await publicKeyThumbprint(b),
		);
	});

	it('signs and verifies with its own keys (RSA-PSS)', async () => {
		const pair = await generateKeyPair({ algorithm: 'rsa' });
		const signature = await signWith(pair);
		await expect(verifyWith(pair, signature)).resolves.toBe(true);
	});

	it('signs and verifies with its own keys (ECDSA)', async () => {
		const pair = await generateKeyPair({ algorithm: 'ec' });
		const signature = await signWith(pair);
		await expect(verifyWith(pair, signature)).resolves.toBe(true);
	});

	it('honours extractable: false — export then fails', async () => {
		const pair = await generateKeyPair({
			algorithm: 'rsa',
			extractable: false,
		});
		expect(pair.privateKey.extractable).toBe(false);
		await expect(exportKeyPairPem(pair)).rejects.toThrow(
			/keyCrypto.exportKey: key is not extractable/,
		);
	});
});

describe('PEM serialization', () => {
	it('emits RFC 7468 headers and ≤64-char base64 lines', async () => {
		const pair = await generateKeyPair({ algorithm: 'rsa' });
		const pem = await exportKeyPairPem(pair);
		expect(pem.algorithm).toBe('rsa');
		expect(pem.privateKeyPem).toMatch(
			/^-----BEGIN PRIVATE KEY-----\n/,
		);
		expect(pem.privateKeyPem).toMatch(/\n-----END PRIVATE KEY-----\n$/);
		expect(pem.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
		expect(pem.publicKeyPem).toMatch(/\n-----END PUBLIC KEY-----\n$/);

		for (const line of pem.privateKeyPem.trim().split('\n').slice(1, -1)) {
			expect(line.length).toBeLessThanOrEqual(64);
		}
	});

	it('round-trips RSA through PEM and still signs/verifies', async () => {
		const pair = await generateKeyPair({ algorithm: 'rsa' });
		const pem = await exportKeyPairPem(pair);
		const restored = await importKeyPairPem(pem);

		expect(await publicKeyThumbprint(restored)).toBe(
			await publicKeyThumbprint(pair),
		);

		const signature = await signWith(restored);
		await expect(verifyWith(restored, signature)).resolves.toBe(true);
		// A signature from the restored key verifies against the original public key.
		await expect(verifyWith(pair, signature)).resolves.toBe(true);
	});

	it('round-trips EC through PEM and still signs/verifies', async () => {
		const pair = await generateKeyPair({ algorithm: 'ec' });
		const pem = await exportKeyPairPem(pair);
		const restored = await importKeyPairPem(pem);

		expect(pem.algorithm).toBe('ec');
		expect(await publicKeyThumbprint(restored)).toBe(
			await publicKeyThumbprint(pair),
		);
		const signature = await signWith(restored);
		await expect(verifyWith(pair, signature)).resolves.toBe(true);
	});

	it('fails closed when the PEM does not match the declared algorithm', async () => {
		const rsaPem = await exportKeyPairPem(
			await generateKeyPair({ algorithm: 'rsa' }),
		);
		await expect(importPrivateKeyPem(rsaPem.privateKeyPem, 'ec')).rejects.toThrow(
			/keyCrypto.importPrivateKeyPem: could not import/,
		);
		await expect(importPublicKeyPem(rsaPem.publicKeyPem, 'ec')).rejects.toThrow(
			/keyCrypto.importPublicKeyPem: could not import/,
		);
	});

	it('rejects garbage and empty PEM input', async () => {
		await expect(importPrivateKeyPem('', 'rsa')).rejects.toThrow(
			/keyCrypto.importPrivateKeyPem: PEM must be a non-empty string/,
		);
		await expect(importPublicKeyPem('not a pem at all', 'rsa')).rejects.toThrow(
			/keyCrypto.importPublicKeyPem: PEM is missing the "-----BEGIN PUBLIC KEY-----" header/,
		);
		await expect(
			importPublicKeyPem('-----BEGIN PUBLIC KEY-----\n\n-----END PUBLIC KEY-----\n', 'rsa'),
		).rejects.toThrow(/keyCrypto: PEM is empty/);
	});

	it('rejects a pair that is not actually a pair', async () => {
		const pair = await generateKeyPair({ algorithm: 'rsa' });
		const solo = pair.publicKey as unknown as CryptoKeyPair;
		await expect(exportKeyPairPem(solo)).rejects.toThrow(
			/keyCrypto: expected a CryptoKeyPair/,
		);
	});
});

describe('JWK export/import', () => {
	it('exports only public parameters for RSA (never d/p/q/dp/dq/qi)', async () => {
		const pair = await generateKeyPair({ algorithm: 'rsa' });
		const jwk = await exportPublicKeyJwk(pair);
		expect(jwk.kty).toBe('RSA');
		expect(jwk.n).toBeTruthy();
		expect(jwk.e).toBe('AQAB');
		expect(jwk.d).toBeUndefined();
		expect(jwk.p).toBeUndefined();
		expect(jwk.q).toBeUndefined();
		expect(jwk.dp).toBeUndefined();
		expect(jwk.dq).toBeUndefined();
		expect(jwk.qi).toBeUndefined();
	});

	it('exports only public parameters for EC (never d)', async () => {
		const pair = await generateKeyPair({ algorithm: 'ec' });
		const jwk = await exportPublicKeyJwk(pair);
		expect(jwk.kty).toBe('EC');
		expect(jwk.crv).toBe('P-256');
		expect(jwk.x).toBeTruthy();
		expect(jwk.y).toBeTruthy();
		expect(jwk.d).toBeUndefined();
	});

	it('round-trips through JWK import with a matching thumbprint', async () => {
		const pair = await generateKeyPair({ algorithm: 'ec' });
		const jwk = await exportPublicKeyJwk(pair);
		const imported = await importPublicKeyJwk(jwk);
		expect(await publicKeyThumbprint(imported)).toBe(
			await publicKeyThumbprint(pair),
		);
	});

	it('rejects JWKs with an unsupported kty', async () => {
		await expect(
			importPublicKeyJwk({ kty: 'oct', k: 'abc' } as JsonWebKey),
		).rejects.toThrow(
			/keyCrypto.importPublicKeyJwk: JWK must be an object with kty/,
		);
	});

	it('rejects private JWKs (module contract: public interchange only)', async () => {
		const pair = await generateKeyPair({ algorithm: 'ec' });
		const publicJwk = await exportPublicKeyJwk(pair);
		const privateJwk = {
			...publicJwk,
			d: 'not-a-real-private-value',
		} as JsonWebKey;
		await expect(importPublicKeyJwk(privateJwk)).rejects.toThrow(
			/keyCrypto.importPublicKeyJwk: could not import the JWK/,
		);
	});
});

describe('publicKeyThumbprint (RFC 7638)', () => {
	it('matches the RFC 7638 §3.1 example vector', async () => {
		const key = await importPublicKeyJwk(RFC7638_RSA_JWK);
		await expect(publicKeyThumbprint(key)).resolves.toBe(
			'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
		);
	});

	it('is a stable 43-char base64url id for a given key', async () => {
		const pair = await generateKeyPair({ algorithm: 'rsa' });
		const thumbprint = await publicKeyThumbprint(pair);
		expect(thumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
		await expect(publicKeyThumbprint(pair)).resolves.toBe(thumbprint);
		await expect(publicKeyThumbprint(pair.publicKey)).resolves.toBe(thumbprint);
	});

	it('differs across algorithms and across keys', async () => {
		const rsa = await generateKeyPair({ algorithm: 'rsa' });
		const ec = await generateKeyPair({ algorithm: 'ec' });
		const anotherRsa = await generateKeyPair({ algorithm: 'rsa' });
		const [tRsa, tEc, tAnother] = await Promise.all([
			publicKeyThumbprint(rsa),
			publicKeyThumbprint(ec),
			publicKeyThumbprint(anotherRsa),
		]);
		expect(tRsa).not.toBe(tEc);
		expect(tRsa).not.toBe(tAnother);
	});
});

describe('publicKeyDescriptor', () => {
	it('describes an RSA key without leaking private material', async () => {
		const pair = await generateKeyPair({ algorithm: 'rsa' });
		const descriptor = await publicKeyDescriptor(pair);
		expect(descriptor).toEqual({
			kty: 'RSA',
			algorithm: 'rsa',
			thumbprint: await publicKeyThumbprint(pair),
			detail: '2048-bit',
		});
		expect(JSON.stringify(descriptor)).not.toContain('privateKeyPem');
	});

	it('describes an EC key with its curve', async () => {
		const pair = await generateKeyPair({ algorithm: 'ec' });
		const descriptor = await publicKeyDescriptor(pair.publicKey);
		expect(descriptor).toEqual({
			kty: 'EC',
			algorithm: 'ec',
			thumbprint: await publicKeyThumbprint(pair),
			detail: 'P-256',
		});
	});
});
