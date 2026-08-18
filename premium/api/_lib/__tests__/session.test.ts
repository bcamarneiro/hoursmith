/**
 * Tests for the session validation middleware (ADA-615).
 *
 * We inject the JWT verifier and the DB store via the `ValidateSessionOptions`
 * interface — no Supabase install or network calls. The underlying `auth.ts`
 * verifier is covered by its own tests; these tests focus on the middleware's
 * orchestration: token extraction, error discrimination, store lookup, and the
 * `withSession` convenience wrapper.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	validateSession,
	withSession,
	type Session,
	type SessionStore,
} from '../session';

// ── Test fixtures ──────────────────────────────────────────────────

const TEST_TOKEN = 'test-jwt';

function makeRequest(opts: {
	authorization?: string;
	method?: string;
	url?: string;
} = {}): Request {
	return new Request(opts.url ?? 'https://hoursmith.io/api/test', {
		method: opts.method ?? 'GET',
		headers: opts.authorization
			? { authorization: opts.authorization }
			: {},
	});
}

/** A valid JWT verifier that returns a known user. */
function validVerifyJwt() {
	return vi.fn().mockResolvedValue({ userId: 'user-abc', email: 'a@b.com' });
}

/** A JWT verifier that rejects the token. */
function rejectingVerifyJwt() {
	return vi.fn().mockResolvedValue(null);
}

/** A store with both profile and subscription populated. */
function populatedStore(): SessionStore {
	return {
		getProfile: vi.fn().mockResolvedValue({
			id: 'user-abc',
			email: 'a@b.com',
			created_at: '2024-01-01T00:00:00Z',
		}),
		getSubscription: vi.fn().mockResolvedValue({
			user_id: 'user-abc',
			stripe_customer_id: 'cus_123',
			stripe_subscription_id: 'sub_456',
			tier: 'premium',
			status: 'active',
			current_period_end: '2026-12-31T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
		}),
	};
}

/** A store where the user has no profile or subscription (only auth.users row). */
function nullStore(): SessionStore {
	return {
		getProfile: vi.fn().mockResolvedValue(null),
		getSubscription: vi.fn().mockResolvedValue(null),
	};
}

/** A store that throws on every lookup. */
function brokenStore(): SessionStore {
	return {
		getProfile: vi.fn().mockRejectedValue(new Error('connection refused')),
		getSubscription: vi.fn().mockRejectedValue(new Error('connection refused')),
	};
}

// ── validateSession ────────────────────────────────────────────────

describe('validateSession', () => {
	beforeEach(() => {
		// Reset env between tests so the env-driven default doesn't leak.
		delete process.env.SUPABASE_URL;
		delete process.env.SUPABASE_SERVICE_ROLE_KEY;
	});

	describe('authorization header extraction', () => {
		it('returns 401 / missing_token when the Authorization header is absent', async () => {
			const result = await validateSession(makeRequest(), {
				store: populatedStore(),
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.status).toBe(401);
			expect(result.code).toBe('missing_token');
		});

		it('returns 401 / missing_token when the header is not a Bearer token', async () => {
			const result = await validateSession(
				makeRequest({ authorization: 'Basic dXNlcjpwYXNz' }),
				{ store: populatedStore() },
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.status).toBe(401);
			expect(result.code).toBe('missing_token');
		});

		it('returns 401 / missing_token when the Bearer value is empty', async () => {
			const result = await validateSession(
				makeRequest({ authorization: 'Bearer   ' }),
				{ store: populatedStore() },
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.status).toBe(401);
			expect(result.code).toBe('missing_token');
		});

		it('trims whitespace from the Bearer value', async () => {
			const verifyJwt = validVerifyJwt();
			const store = populatedStore();
			const result = await validateSession(
				makeRequest({ authorization: 'Bearer    my-token   ' }),
				{ verifyJwtFn: verifyJwt, store },
			);
			expect(result.ok).toBe(true);
			expect(verifyJwt).toHaveBeenCalledWith('my-token');
		});
	});

	describe('JWT verification', () => {
		it('returns 401 / invalid_token when the JWT is rejected', async () => {
			const result = await validateSession(
				makeRequest({ authorization: 'Bearer bad-jwt' }),
				{ verifyJwtFn: rejectingVerifyJwt(), store: populatedStore() },
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.status).toBe(401);
			expect(result.code).toBe('invalid_token');
		});

		it('returns 401 / invalid_token when the injected verifier returns null', async () => {
			const result = await validateSession(
				makeRequest({ authorization: 'Bearer expired-jwt' }),
				{
					verifyJwtFn: vi.fn().mockResolvedValue(null),
					store: populatedStore(),
				},
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.status).toBe(401);
			expect(result.code).toBe('invalid_token');
		});

		it('does NOT call the store when the JWT is invalid', async () => {
			const store = populatedStore();
			const result = await validateSession(
				makeRequest({ authorization: 'Bearer bad' }),
				{ verifyJwtFn: rejectingVerifyJwt(), store },
			);
			expect(result.ok).toBe(false);
			expect(store.getProfile).not.toHaveBeenCalled();
			expect(store.getSubscription).not.toHaveBeenCalled();
		});
	});

	describe('store resolution', () => {
		it('returns 500 / server_misconfigured when no store is injected and env is unset', async () => {
			// Ensure env is clean.
			delete process.env.SUPABASE_URL;
			delete process.env.SUPABASE_SERVICE_ROLE_KEY;
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const result = await validateSession(
				makeRequest({ authorization: 'Bearer valid-jwt' }),
				{ verifyJwtFn: validVerifyJwt() },
				// No store injected — falls back to defaultSupabaseAdmin() which
				// requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.status).toBe(500);
			expect(result.code).toBe('server_misconfigured');
			expect(warnSpy).toHaveBeenCalledWith(
				'[session] Failed to resolve Supabase admin client:',
				expect.any(String),
			);
			warnSpy.mockRestore();
		});

		it('returns 500 / server_misconfigured when the store lookup fails', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const result = await validateSession(
				makeRequest({ authorization: 'Bearer valid-jwt' }),
				{ verifyJwtFn: validVerifyJwt(), store: brokenStore() },
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.status).toBe(500);
			expect(result.code).toBe('server_misconfigured');
			expect(warnSpy).toHaveBeenCalledWith(
				'[session] DB lookup failed for user',
				'user-abc',
				':',
				expect.any(String),
			);
			warnSpy.mockRestore();
		});
	});

	describe('successful session resolution', () => {
		it('returns full session data when JWT, profile, and subscription all resolve', async () => {
			const verifyJwt = validVerifyJwt();
			const store = populatedStore();
			const result = await validateSession(
				makeRequest({ authorization: 'Bearer valid-jwt' }),
				{ verifyJwtFn: verifyJwt, store },
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.session.userId).toBe('user-abc');
			expect(result.session.email).toBe('a@b.com');
			expect(result.session.profile).toEqual({
				id: 'user-abc',
				email: 'a@b.com',
				created_at: '2024-01-01T00:00:00Z',
			});
			expect(result.session.subscription).toEqual({
				user_id: 'user-abc',
				stripe_customer_id: 'cus_123',
				stripe_subscription_id: 'sub_456',
				tier: 'premium',
				status: 'active',
				current_period_end: '2026-12-31T00:00:00Z',
				updated_at: '2026-01-01T00:00:00Z',
			});
			expect(verifyJwt).toHaveBeenCalledWith('valid-jwt');
			expect(store.getProfile).toHaveBeenCalledWith('user-abc');
			expect(store.getSubscription).toHaveBeenCalledWith('user-abc');
		});

		it('returns null profile and subscription when neither row exists', async () => {
			const verifyJwt = validVerifyJwt();
			const store = nullStore();
			const result = await validateSession(
				makeRequest({ authorization: 'Bearer valid-jwt' }),
				{ verifyJwtFn: verifyJwt, store },
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.session.userId).toBe('user-abc');
			expect(result.session.profile).toBeNull();
			expect(result.session.subscription).toBeNull();
		});

		it('returns null email when the JWT has no email claim', async () => {
			const verifyJwt = vi
				.fn()
				.mockResolvedValue({ userId: 'user-xyz', email: null });
			const result = await validateSession(
				makeRequest({ authorization: 'Bearer token-no-email' }),
				{ verifyJwtFn: verifyJwt, store: nullStore() },
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.session.email).toBeNull();
		});
	});
});

// ── withSession convenience wrapper ────────────────────────────────

describe('withSession', () => {
	beforeEach(() => {
		delete process.env.SUPABASE_URL;
		delete process.env.SUPABASE_SERVICE_ROLE_KEY;
	});

	it('calls the handler with the resolved session on success', async () => {
		const handler = vi
			.fn()
			.mockResolvedValue(new Response('ok', { status: 200 }));
		const wrapped = withSession(handler, {
			verifyJwtFn: validVerifyJwt(),
			store: populatedStore(),
		});
		const res = await wrapped(
			makeRequest({ authorization: 'Bearer valid-jwt' }),
		);
		expect(res.status).toBe(200);
		expect(handler).toHaveBeenCalledOnce();
		const session: Session = handler.mock.calls[0][1];
		expect(session.userId).toBe('user-abc');
	});

	it('returns a JSON error response on auth failure', async () => {
		const handler = vi.fn();
		const wrapped = withSession(handler, {
			verifyJwtFn: rejectingVerifyJwt(),
			store: populatedStore(),
		});
		const res = await wrapped(
			makeRequest({ authorization: 'Bearer bad-jwt' }),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get('content-type')).toBe('application/json');
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('invalid_token');
		// Handler must never be called on auth failure.
		expect(handler).not.toHaveBeenCalled();
	});

	it('does not call the handler when the Authorization header is missing', async () => {
		const handler = vi.fn();
		const wrapped = withSession(handler, { store: populatedStore() });
		const res = await wrapped(makeRequest());
		expect(res.status).toBe(401);
		expect(handler).not.toHaveBeenCalled();
	});

	it('passes through the SessionHandler return value on success', async () => {
		const body = { message: 'hello' };
		const wrapped = withSession(async (_req, _session) => {
			return new Response(JSON.stringify(body), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			});
		}, {
			verifyJwtFn: validVerifyJwt(),
			store: populatedStore(),
		});
		const res = await wrapped(
			makeRequest({ authorization: 'Bearer valid-jwt' }),
		);
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual(body);
	});
});
