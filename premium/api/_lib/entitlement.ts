/**
 * Entitlement check for Hoursmith Premium Vercel Functions.
 *
 * Verifies a Supabase JWT from the `Authorization: Bearer <token>` header and
 * looks up the matching row in `public.subscriptions` to confirm the user
 * has an `active` premium subscription.
 *
 * This module is intentionally dependency-free so it compiles today, before
 * ADA-254 wires the real `@supabase/supabase-js` package. The Supabase REST
 * lookup is performed via `fetch`. When ADA-254 lands, swap `defaultClient`
 * for the official SDK client; the {@link SupabaseLikeClient} interface keeps
 * the call sites stable and tests inject a mock through the same shape.
 *
 * Linear: ADA-272 (this file), ADA-254 (Supabase project bringup),
 * ADA-343 (JWT verify consolidated into _lib/auth.ts).
 */

import { userIdFromToken } from './auth.js';

export type SubscriptionStatus =
	| 'active'
	| 'past_due'
	| 'canceled'
	| 'incomplete'
	| 'trialing'
	| 'unpaid';

export type SubscriptionTier = 'free' | 'premium';

export interface Entitlement {
	ok: true;
	userId: string;
	tier: SubscriptionTier;
	status: SubscriptionStatus;
}

export type EntitlementErrorCode =
	| 'missing_token'
	| 'invalid_token'
	| 'subscription_required'
	| 'server_misconfigured';

export interface EntitlementError {
	ok: false;
	status: 401 | 403 | 500;
	code: EntitlementErrorCode;
	message: string;
}

export type EntitlementResult = Entitlement | EntitlementError;

/**
 * Minimal surface the entitlement check needs from a Supabase-shaped client.
 * Lets us swap the real SDK in later (ADA-254) without touching call sites,
 * and lets unit tests provide a hand-rolled mock with zero install.
 */
export interface SupabaseLikeClient {
	/** Verify a JWT and return the user id, or `null` if invalid/expired. */
	getUserIdFromToken(token: string): Promise<string | null>;
	/** Read the subscriptions row for `user_id`, or `null` if none. */
	getSubscription(
		userId: string,
	): Promise<{ tier: SubscriptionTier; status: SubscriptionStatus } | null>;
}

export interface GetEntitlementOptions {
	/** Inject a client (tests). Defaults to the env-driven fetch client. */
	client?: SupabaseLikeClient;
}

/**
 * Verify the request's Supabase JWT and confirm an active premium subscription.
 *
 * Returns either an {@link Entitlement} (caller may proceed) or an
 * {@link EntitlementError} that the caller MUST translate to an HTTP response.
 * Never throws on auth/subscription failures — only on programmer error.
 */
export async function getEntitlement(
	request: Request,
	options: GetEntitlementOptions = {},
): Promise<EntitlementResult> {
	const authHeader = request.headers.get('authorization');
	const token = extractBearer(authHeader);
	if (!token) {
		return {
			ok: false,
			status: 401,
			code: 'missing_token',
			message: 'Missing Authorization: Bearer <token> header.',
		};
	}

	let client: SupabaseLikeClient;
	try {
		client = options.client ?? defaultClient();
	} catch (err) {
		return {
			ok: false,
			status: 500,
			code: 'server_misconfigured',
			message: (err as Error).message,
		};
	}

	const userId = await client.getUserIdFromToken(token);
	if (!userId) {
		return {
			ok: false,
			status: 401,
			code: 'invalid_token',
			message: 'Supabase JWT is invalid or expired.',
		};
	}

	const subscription = await client.getSubscription(userId);
	if (!subscription || subscription.status !== 'active') {
		return {
			ok: false,
			status: 403,
			code: 'subscription_required',
			message: 'Active premium subscription required.',
		};
	}

	return {
		ok: true,
		userId,
		tier: subscription.tier,
		status: subscription.status,
	};
}

function extractBearer(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}

/**
 * Env-driven Supabase client. Stubbed until ADA-254 wires the real project;
 * the structure is final, only the underlying transport changes.
 *
 * Required env vars (set in Vercel project settings):
 *   - SUPABASE_URL                — e.g. https://<ref>.supabase.co
 *   - SUPABASE_SERVICE_ROLE_KEY   — server-only; never expose to the browser
 */
function defaultClient(): SupabaseLikeClient {
	const url = process.env.SUPABASE_URL;
	const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !serviceRoleKey) {
		throw new Error(
			'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. See ADA-254.',
		);
	}
	return new FetchSupabaseClient(url, serviceRoleKey);
}

/**
 * Tiny Supabase REST client used until ADA-254 swaps in `@supabase/supabase-js`.
 * Kept private to this module so the surface area stays small.
 */
class FetchSupabaseClient implements SupabaseLikeClient {
	constructor(
		private readonly url: string,
		private readonly serviceRoleKey: string,
	) {}

	async getUserIdFromToken(token: string): Promise<string | null> {
		// Consolidated verify (ADA-343): local JWKS signature check with a REST
		// (`GET /auth/v1/user`) fallback. Avoids the GoTrue round-trip on the hot
		// proxy path when the project uses asymmetric (ES256/RS256) JWTs.
		return userIdFromToken(token, {
			env: {
				SUPABASE_URL: this.url,
				SUPABASE_SERVICE_ROLE_KEY: this.serviceRoleKey,
			},
		});
	}

	async getSubscription(
		userId: string,
	): Promise<{ tier: SubscriptionTier; status: SubscriptionStatus } | null> {
		// PostgREST: SELECT tier, status FROM subscriptions WHERE user_id = ?
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			select: 'tier,status',
		});
		const res = await fetch(
			`${this.url}/rest/v1/subscriptions?${params.toString()}`,
			{
				headers: {
					apikey: this.serviceRoleKey,
					authorization: `Bearer ${this.serviceRoleKey}`,
					accept: 'application/json',
				},
			},
		);
		if (!res.ok) return null;
		const rows = (await res.json()) as Array<{
			tier: SubscriptionTier;
			status: SubscriptionStatus;
		}>;
		return rows[0] ?? null;
	}
}
