import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	validateJwtExpiry,
	validateToken,
	validateAllTokens,
	errorIndicatesTokenRotation,
} from '../tokenService';
import { ServiceError } from '../serviceErrors';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Build a well-formed JWT payload with the given `exp` claim. The header and
 * signature are dummy strings — we only read the payload locally.
 */
function makeJwt(exp: number | undefined): string {
	const header = btoa(JSON.stringify({ alg: 'ES256', kid: 'test' }));
	const payload = btoa(
		JSON.stringify(
			exp !== undefined
				? { sub: 'u_abc', email: 'user@test.co', exp }
				: { sub: 'u_abc', email: 'user@test.co' },
		),
	);
	return `${header}.${payload}.dummy_sig`;
}

// ── validateJwtExpiry ─────────────────────────────────────────────────

describe('validateJwtExpiry', () => {
	it('returns valid=false with null times for a malformed token', () => {
		const result = validateJwtExpiry('not-a-jwt', 1_000_000);
		expect(result.valid).toBe(false);
		expect(result.expiresAtMs).toBeNull();
		expect(result.remainingMs).toBeNull();
	});

	it('returns valid=false for a token without an `exp` claim', () => {
		const token = makeJwt(undefined);
		const result = validateJwtExpiry(token, 1_000_000);
		expect(result.valid).toBe(false);
		expect(result.expiresAtMs).toBeNull();
	});

	it('returns valid=false for an expired token (past exp + skew)', () => {
		// exp = 1000 (epoch seconds), now = 1_100_000 (epoch ms = 1100s)
		// exp*1000 = 1_000_000, skew = 60_000, so deadline = 1_060_000
		// now = 1_100_000 > deadline => expired
		const token = makeJwt(1000);
		const result = validateJwtExpiry(token, 1_100_000);
		expect(result.valid).toBe(false);
		expect(result.remainingMs).toBe(1_000_000 - 1_100_000);
	});

	it('treats a token within clock-skew as still valid', () => {
		// exp = 1000, now = 1_030_000 (1030s)
		// exp*1000 = 1_000_000, skew = 60_000, deadline = 1_060_000
		// now = 1_030_000 ≤ deadline => still valid
		const token = makeJwt(1000);
		const result = validateJwtExpiry(token, 1_030_000);
		expect(result.valid).toBe(true);
		expect(result.remainingMs).toBe(1_000_000 - 1_030_000);
	});

	it('returns valid=true for a clearly valid token', () => {
		const token = makeJwt(1_000_000);
		const result = validateJwtExpiry(token, 1_000);
		expect(result.valid).toBe(true);
		expect(result.expiresAtMs).toBe(1_000_000_000);
		expect(result.remainingMs).toBe(1_000_000_000 - 1_000);
	});
});

// ── validateToken ─────────────────────────────────────────────────────

describe('validateToken', () => {
	it('returns missing for an empty string on any source', () => {
		for (const source of ['jira', 'gitlab', 'rescueTime', 'supabase'] as const) {
			const h = validateToken(source, '');
			expect(h.status).toBe('missing');
		}
	});

	it('returns invalid-format for a too-short Jira token', () => {
		const h = validateToken('jira', 'short');
		expect(h.status).toBe('invalid-format');
	});

	it('returns valid for a long-enough Jira token', () => {
		const h = validateToken('jira', 'a'.repeat(24));
		expect(h.status).toBe('valid');
	});

	it('returns invalid-format for a too-short GitLab token', () => {
		const h = validateToken('gitlab', 'short');
		expect(h.status).toBe('invalid-format');
	});

	it('returns valid for a long-enough GitLab token', () => {
		const h = validateToken('gitlab', 'a'.repeat(20));
		expect(h.status).toBe('valid');
	});

	it('returns invalid-format for a too-short RescueTime key', () => {
		const h = validateToken('rescueTime', 'short');
		expect(h.status).toBe('invalid-format');
	});

	it('returns valid for a long-enough RescueTime key', () => {
		const h = validateToken('rescueTime', 'a'.repeat(32));
		expect(h.status).toBe('valid');
	});

	it('returns expired for an expired supabase JWT', () => {
		const token = makeJwt(500);
		const h = validateToken('supabase', token, 1_000_000);
		expect(h.status).toBe('expired');
	});

	it('returns expiring-soon for a JWT within 5 minutes of expiry', () => {
		// exp = 1010 (epoch seconds), now = 1_007_000 (epoch ms = 1007s)
		// remainingMs = 1_010_000 - 1_007_000 = 3000 < 5 min => expiring-soon
		const token = makeJwt(1010);
		const h = validateToken('supabase', token, 1_007_000);
		expect(h.status).toBe('expiring-soon');
	});

	it('returns valid for a JWT far from expiry', () => {
		const token = makeJwt(1_000_000);
		const h = validateToken('supabase', token, 1_000);
		expect(h.status).toBe('valid');
	});

	it('returns missing for an empty supabase JWT', () => {
		const h = validateToken('supabase', '');
		expect(h.status).toBe('missing');
	});

	it('returns expired for a malformed JWT (no exp claim)', () => {
		const h = validateToken('supabase', 'a.b.c', 1_000_000);
		// exp claim absent => valid=false => expired
		expect(h.status).toBe('expired');
	});
});

// ── validateAllTokens ─────────────────────────────────────────────────

describe('validateAllTokens', () => {
	it('returns 4 results', () => {
		const results = validateAllTokens({});
		expect(results).toHaveLength(4);
	});

	it('accepts a partial map of tokens', () => {
		const results = validateAllTokens({ jira: 'a'.repeat(24) });
		const jira = results.find((r) => r.source === 'jira');
		expect(jira?.status).toBe('valid');

		const gitlab = results.find((r) => r.source === 'gitlab');
		expect(gitlab?.status).toBe('missing');
	});

	it('passes nowMs through to supabase JWT checks', () => {
		const expired = makeJwt(1);
		const results = validateAllTokens(
			{ supabase: expired },
			1_000_000,
		);
		const supabase = results.find((r) => r.source === 'supabase');
		expect(supabase?.status).toBe('expired');
	});
});

// ── errorIndicatesTokenRotation ───────────────────────────────────────

describe('errorIndicatesTokenRotation', () => {
	it('returns null for undefined/null input', () => {
		expect(errorIndicatesTokenRotation(null)).toBeNull();
		expect(errorIndicatesTokenRotation(undefined)).toBeNull();
	});

	it('returns sourceHint for an invalid-token ServiceError', () => {
		const err = new ServiceError({
			kind: 'invalid-token',
			source: 'rescuetime',
			message: 'invalid RescueTime API key',
		});
		expect(errorIndicatesTokenRotation(err, 'rescueTime')).toBe('rescueTime');
	});

	it('returns gitlab for an invalid-token ServiceError from GitLab', () => {
		const err = new ServiceError({
			kind: 'invalid-token',
			source: 'gitlab',
			message: 'invalid token',
		});
		expect(errorIndicatesTokenRotation(err)).toBe('gitlab');
	});

	it('returns jira for an unauthorized ServiceError', () => {
		const err = new ServiceError({
			kind: 'unauthorized',
			source: 'jira',
			message: '401 Unauthorized',
		});
		expect(errorIndicatesTokenRotation(err)).toBe('jira');
	});

	it('returns null for a non-token ServiceError', () => {
		const err = new ServiceError({
			kind: 'not-found',
			source: 'jira',
			message: '404 Not Found',
		});
		expect(errorIndicatesTokenRotation(err)).toBeNull();
	});

	it('returns supabase for entitlementCode invalid_token', () => {
		const err = new ServiceError({
			kind: 'unauthorized',
			source: 'proxy',
			status: 401,
			message: 'Session expired',
			entitlementCode: 'invalid_token',
		});
		expect(errorIndicatesTokenRotation(err)).toBe('supabase');
	});

	it('returns supabase for entitlementCode missing_token', () => {
		const err = new ServiceError({
			kind: 'unauthorized',
			source: 'proxy',
			status: 401,
			message: 'No session',
			entitlementCode: 'missing_token',
		});
		expect(errorIndicatesTokenRotation(err)).toBe('supabase');
	});

	it('does not return supabase for other entitlement codes', () => {
		const err = new ServiceError({
			kind: 'forbidden',
			source: 'proxy',
			status: 403,
			message: 'Subscription required',
			entitlementCode: 'subscription_required',
		});
		expect(errorIndicatesTokenRotation(err)).toBeNull();
	});

	it('detects token-invalid text in legacy string errors', () => {
		const err = new Error('The token is invalid or expired');
		expect(errorIndicatesTokenRotation(err)).toBe('jira');
	});

	it('detects invalid API key text in legacy string errors', () => {
		const err = new Error('API key is invalid');
		expect(errorIndicatesTokenRotation(err, 'rescueTime')).toBe('rescueTime');
	});

	it('returns null for non-token legacy string errors', () => {
		const err = new Error('Network error');
		expect(errorIndicatesTokenRotation(err)).toBeNull();
	});
});
