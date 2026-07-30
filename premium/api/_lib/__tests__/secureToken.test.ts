/**
 * Tests for the secure-token signing & verification utility (ADA-629).
 *
 * Layers:
 *  - validateSecretKey: rejects short, homogenous, and empty keys.
 *  - signRefreshToken: rejects an invalid key, auto-sets iat.
 *  - round-trip: sign → verify returns the same payload.
 *  - tamper detection: a modified token (header, payload, sig) is rejected.
 *  - expiry: an expired token is rejected even with a valid signature.
 *  - version: tokenVersion round-trips correctly.
 *  - injected key: sign with a known key, verify with the same → match;
 *    verify with a different key → reject.
 */

import { describe, expect, it } from 'vitest';
import {
	signRefreshToken,
	type RefreshTokenPayload,
	validateSecretKey,
	verifyRefreshToken,
} from '../secureToken.js';

// A key that passes validation (32+ bytes, multi-class).
const VALID_SECRET = 'aB3#' + 'x'.repeat(28) + 'yZ9!'; // 34 bytes, all 4 classes
const SHORT_SECRET = 'short'; // 5 bytes — well below MIN_KEY_BYTES
const WEAK_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 32 bytes, single class

const NOW_SEC = Math.floor(Date.now() / 1000);
const FUTURE = NOW_SEC + 3600;
const PAST = NOW_SEC - 3600;

describe('validateSecretKey', () => {
	it('rejects an empty string', () => {
		const r = validateSecretKey('');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/non-empty/);
	});

	it('rejects a secret shorter than 32 bytes', () => {
		const r = validateSecretKey(SHORT_SECRET);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/at least 32/i);
	});

	it('rejects a secret with only one character class', () => {
		const r = validateSecretKey(WEAK_SECRET);
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/2 character classes/i);
	});

	it('accepts a secret meeting all requirements', () => {
		expect(validateSecretKey(VALID_SECRET)).toEqual({ valid: true });
	});

	it('accepts a secret with exactly 2 character classes', () => {
		// 32 bytes, uppercase + digits
		const twoClass = 'A' + 'B' + '0'.repeat(30);
		expect(validateSecretKey(twoClass)).toEqual({ valid: true });
	});
});

describe('signRefreshToken — key validation', () => {
	it('throws for a short secret', async () => {
		await expect(
			signRefreshToken({ sub: 'u1' }, SHORT_SECRET),
		).rejects.toThrow(/secret/i);
	});

	it('throws for a single-class secret', async () => {
		await expect(
			signRefreshToken({ sub: 'u1' }, WEAK_SECRET),
		).rejects.toThrow(/secret/i);
	});

	it('auto-sets iat when omitted', async () => {
		const before = Math.floor(Date.now() / 1000);
		const token = await signRefreshToken({ sub: 'u1' }, VALID_SECRET);
		const payload = await verifyRefreshToken(token, VALID_SECRET);
		expect(payload).not.toBeNull();
		expect(payload!.iat).toBeGreaterThanOrEqual(before);
		expect(payload!.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
	});
});

describe('verifyRefreshToken — round-trip', () => {
	it('returns the same payload after sign + verify', async () => {
		const payload: RefreshTokenPayload = {
			sub: 'user-42',
			exp: FUTURE,
			jti: 'unique-id-1',
			tokenVersion: 3,
			scope: 'offline_access',
		};
		const token = await signRefreshToken(payload, VALID_SECRET);
		const decoded = await verifyRefreshToken(token, VALID_SECRET);
		expect(decoded).not.toBeNull();
		expect(decoded!.sub).toBe('user-42');
		expect(decoded!.exp).toBe(FUTURE);
		expect(decoded!.jti).toBe('unique-id-1');
		expect(decoded!.tokenVersion).toBe(3);
		expect(decoded!.scope).toBe('offline_access');
		// iat was auto-set
		expect(decoded!.iat).toBeGreaterThan(0);
	});

	it('round-trips a minimal (sub-only) payload', async () => {
		const token = await signRefreshToken({ sub: 'u1' }, VALID_SECRET);
		const decoded = await verifyRefreshToken(token, VALID_SECRET);
		expect(decoded).not.toBeNull();
		expect(decoded!.sub).toBe('u1');
	});
});

describe('verifyRefreshToken — tamper detection', () => {
	it('rejects a tampered header', async () => {
		const token = await signRefreshToken({ sub: 'u1', exp: FUTURE }, VALID_SECRET);
		const parts = token.split('.');
		// Replace header with a different encoding
		const tampered = `ZGVmYXVsdA.${parts[1]}.${parts[2]}`;
		expect(await verifyRefreshToken(tampered, VALID_SECRET)).toBeNull();
	});

	it('rejects a tampered payload', async () => {
		const token = await signRefreshToken({ sub: 'u1', exp: FUTURE }, VALID_SECRET);
		const [h, _p, s] = token.split('.');
		const fakePayload = btoa(JSON.stringify({ sub: 'attacker', exp: FUTURE }))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		const forged = `${h}.${fakePayload}.${s}`;
		expect(await verifyRefreshToken(forged, VALID_SECRET)).toBeNull();
	});

	it('rejects a tampered signature', async () => {
		const token = await signRefreshToken({ sub: 'u1', exp: FUTURE }, VALID_SECRET);
		const tampered = token.slice(0, -1) + 'a';
		expect(await verifyRefreshToken(tampered, VALID_SECRET)).toBeNull();
	});

	it('rejects a malformed token (not 3 parts)', async () => {
		expect(await verifyRefreshToken('a.b', VALID_SECRET)).toBeNull();
		expect(await verifyRefreshToken('a.b.c.d', VALID_SECRET)).toBeNull();
		expect(await verifyRefreshToken('', VALID_SECRET)).toBeNull();
	});

	it('rejects a token signed with a different key', async () => {
		const otherSecret = 'xY9#' + 'z'.repeat(28) + 'aB2!';
		const token = await signRefreshToken(
			{ sub: 'u1', exp: FUTURE },
			VALID_SECRET,
		);
		expect(await verifyRefreshToken(token, otherSecret)).toBeNull();
	});
});

describe('verifyRefreshToken — expiry', () => {
	it('accepts a token with a future exp', async () => {
		const token = await signRefreshToken(
			{ sub: 'u1', exp: FUTURE },
			VALID_SECRET,
		);
		expect(await verifyRefreshToken(token, VALID_SECRET)).not.toBeNull();
	});

	it('rejects a token with a past exp', async () => {
		const token = await signRefreshToken(
			{ sub: 'u1', exp: PAST },
			VALID_SECRET,
		);
		expect(await verifyRefreshToken(token, VALID_SECRET)).toBeNull();
	});

	it('accepts a token with no exp (unbounded)', async () => {
		const token = await signRefreshToken({ sub: 'u1' }, VALID_SECRET);
		expect(await verifyRefreshToken(token, VALID_SECRET)).not.toBeNull();
	});
});
