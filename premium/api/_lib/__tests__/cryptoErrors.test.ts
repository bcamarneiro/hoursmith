/**
 * Tests for the crypto exception hierarchy (ADA-715).
 *
 * The leaf classes are what `aesCrypto.ts` throws, so tests assert both the
 * structural contract (name, message, `instanceof` relationships) and that
 * each leaf is catchable as the shared `CryptoError` base.
 */

import { describe, expect, it } from 'vitest';
import {
	CryptoDecryptError,
	CryptoError,
	CryptoKeyError,
	CryptoPayloadError,
} from '../cryptoErrors.js';

describe('cryptoErrors hierarchy', () => {
	it('CryptoError is the shared base and a real Error', () => {
		const err = new CryptoError('crypto went wrong');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('CryptoError');
		expect(err.message).toBe('crypto went wrong');
	});

	it('CryptoKeyError extends CryptoError', () => {
		const err = new CryptoKeyError('invalid key material');
		expect(err).toBeInstanceOf(CryptoError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('CryptoKeyError');
		expect(err.message).toBe('invalid key material');
	});

	it('CryptoPayloadError extends CryptoError', () => {
		const err = new CryptoPayloadError('malformed payload');
		expect(err).toBeInstanceOf(CryptoError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('CryptoPayloadError');
		expect(err.message).toBe('malformed payload');
	});

	it('CryptoDecryptError extends CryptoError', () => {
		const err = new CryptoDecryptError('authentication failed');
		expect(err).toBeInstanceOf(CryptoError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('CryptoDecryptError');
		expect(err.message).toBe('authentication failed');
	});

	it('every leaf is catchable as the base CryptoError', () => {
		const leaves = [
			new CryptoKeyError('a'),
			new CryptoPayloadError('b'),
			new CryptoDecryptError('c'),
		];
		for (const leaf of leaves) {
			expect(leaf instanceof CryptoError).toBe(true);
			expect(leaf instanceof Error).toBe(true);
		}
	});

	it('leaves are not interchangeable — instanceof is exact', () => {
		expect(new CryptoKeyError('a')).not.toBeInstanceOf(CryptoPayloadError);
		expect(new CryptoKeyError('a')).not.toBeInstanceOf(CryptoDecryptError);
		expect(new CryptoPayloadError('b')).not.toBeInstanceOf(CryptoDecryptError);
		expect(new CryptoDecryptError('c')).not.toBeInstanceOf(CryptoKeyError);
	});
});
