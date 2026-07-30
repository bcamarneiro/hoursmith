/**
 * Session validation middleware for Hoursmith Premium Vercel Functions.
 *
 * Validates the Supabase JWT Bearer token on incoming requests and resolves
 * the user's session data (profile + subscription) from the database. Returns
 * a typed result the caller pattern-matches on, and provides a higher-order
 * `withSession` wrapper that auto-responds with the right error on auth failure.
 *
 * This module delegates JWT verification to `_lib/auth.ts` (local JWKS +
 * REST fallback) and DB lookups to `_lib/supabaseAdmin.ts`. It does NOT gate
 * on subscription tier — that's the caller's decision.
 *
 * Edge-runtime compatible: `fetch`-backed, no Node-only deps.
 *
 * Linear: ADA-615.
 */

import { verifyJwt, type VerifiedToken } from './auth.js';
import {
	defaultSupabaseAdmin,
	type ProfileRow,
	type SubscriptionRow,
} from './supabaseAdmin.js';

// ── Public types ──────────────────────────────────────────────────

export interface Session {
	userId: string;
	email: string | null;
	profile: ProfileRow | null;
	subscription: SubscriptionRow | null;
}

export type SessionErrorCode =
	| 'missing_token'
	| 'invalid_token'
	| 'server_misconfigured';

export type SessionResult =
	| { ok: true; session: Session }
	| { ok: false; status: 401 | 500; code: SessionErrorCode; message: string };

// ── Injectable deps (for tests) ───────────────────────────────────

/**
 * Minimal surface the session middleware needs from a Supabase-shaped store.
 * Kept narrow so unit tests can provide a hand-rolled mock with zero install.
 */
export interface SessionStore {
	getProfile(userId: string): Promise<ProfileRow | null>;
	getSubscription(userId: string): Promise<SubscriptionRow | null>;
}

export interface ValidateSessionOptions {
	/** Inject a store (tests). Defaults to the env-driven Supabase admin client. */
	store?: SessionStore;
	/**
	 * Override JWT verifier (tests). Receives the raw token string and returns
	 * `VerifiedToken` on success or `null` on failure.
	 */
	verifyJwtFn?: (token: string) => Promise<VerifiedToken | null>;
	/**
	 * When true, forces a live GoTrue check instead of the local-first path.
	 * Use for sensitive endpoints where a deleted/revoked user must be rejected
	 * immediately rather than living until token expiry (ADA-343).
	 */
	confirmWithServer?: boolean;
}

// ── Main API ───────────────────────────────────────────────────────

/**
 * Validate the request's Supabase JWT and resolve the user's session.
 *
 * Returns `{ ok: true, session: { userId, email, profile, subscription } }`
 * on success, or a discriminated error with status/code/message on failure.
 *
 * The caller decides what to do with profile/subscription — this function
 * does not gate on subscription tier.
 */
export async function validateSession(
	request: Request,
	options: ValidateSessionOptions = {},
): Promise<SessionResult> {
	// 1. Extract Bearer token from the Authorization header.
	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		return {
			ok: false,
			status: 401,
			code: 'missing_token',
			message: 'Missing Authorization: Bearer <token> header.',
		};
	}

	// 2. Verify the JWT.
	let verified: VerifiedToken | null;
	if (options.verifyJwtFn) {
		verified = await options.verifyJwtFn(token);
	} else {
		verified = await verifyJwt(token, {
			confirmWithServer: options.confirmWithServer ?? false,
		});
	}

	if (!verified) {
		return {
			ok: false,
			status: 401,
			code: 'invalid_token',
			message: 'Supabase JWT is invalid or expired.',
		};
	}

	// 3. Resolve the DB store. Defaults to the env-driven admin client; throws
	//    if env vars are missing (caught below and surfaced as server_misconfigured).
	let store: SessionStore;
	try {
		store = options.store ?? toSessionStore(defaultSupabaseAdmin());
	} catch (err) {
		return {
			ok: false,
			status: 500,
			code: 'server_misconfigured',
			message: (err as Error).message,
		};
	}

	// 4. Look up profile + subscription from the DB concurrently.
	let profile: ProfileRow | null;
	let subscription: SubscriptionRow | null;
	try {
		[profile, subscription] = await Promise.all([
			store.getProfile(verified.userId),
			store.getSubscription(verified.userId),
		]);
	} catch (err) {
		return {
			ok: false,
			status: 500,
			code: 'server_misconfigured',
			message: `DB lookup failed: ${(err as Error).message}`,
		};
	}

	return {
		ok: true,
		session: {
			userId: verified.userId,
			email: verified.email,
			profile,
			subscription,
		},
	};
}

// ── Convenience wrapper ────────────────────────────────────────────

/**
 * A Vercel Function handler that receives a validated {@link Session}.
 * The middleware guarantees the session is valid before calling this handler;
 * on auth failure it returns the appropriate error response instead.
 */
export type SessionHandler = (
	request: Request,
	session: Session,
) => Response | Promise<Response>;

/**
 * Wrap a {@link SessionHandler} so auth errors are handled automatically.
 *
 * ```ts
 * export default withSession(async (request, session) => {
 *   return jsonResponse(200, { userId: session.userId });
 * });
 * ```
 *
 * Additional `options` are forwarded to {@link validateSession} so integrations
 * can override the store or verifier. Omit them for production — the defaults
 * hit the env-driven Supabase admin client + auth.ts local-first verify.
 */
export function withSession(
	handler: SessionHandler,
	options: ValidateSessionOptions = {},
): (request: Request) => Promise<Response> {
	return async (request: Request): Promise<Response> => {
		const result = await validateSession(request, options);
		if (!result.ok) {
			return new Response(JSON.stringify({ error: result.code }), {
				status: result.status,
				headers: { 'content-type': 'application/json' },
			});
		}
		return handler(request, result.session);
	};
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Adapts the full SupabaseAdminClient down to the narrow SessionStore surface
 * so `validateSession` only sees the two methods it needs. The `bind` calls
 * preserve `this` when the admin client's methods reference instance state.
 */
function toSessionStore(
	admin: import('./supabaseAdmin.js').SupabaseAdminClient,
): SessionStore {
	return {
		getProfile: admin.getProfile.bind(admin),
		getSubscription: admin.getSubscription.bind(admin),
	};
}

function extractBearer(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}
