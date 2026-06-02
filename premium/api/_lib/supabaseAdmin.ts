/**
 * Service-role Supabase REST client for server-side admin operations.
 *
 * Dependency-free `fetch` wrapper, mirroring `entitlement.ts`. When ADA-254
 * swaps in `@supabase/supabase-js`, the {@link SupabaseAdminClient} interface
 * stays — only the underlying transport changes.
 *
 * NEVER expose the service-role key to the browser.
 *
 * Linear: ADA-263, ADA-264, ADA-343 (JWT verify via _lib/auth.ts).
 */

import { userIdFromToken } from './auth.js';

export interface ProfileRow {
	id: string;
	email: string;
	created_at: string;
}

export interface SubscriptionRow {
	user_id: string;
	// NOTE: despite the `stripe_` prefix these columns now hold Polar IDs after
	// the ADA-294 migration. Kept as-is to avoid a production DB rename; a
	// cosmetic rename to provider_* is optional future work.
	stripe_customer_id: string;
	stripe_subscription_id: string | null;
	tier: string;
	status: string;
	current_period_end: string | null;
	updated_at: string;
}

export interface SubscriptionUpsert {
	user_id: string;
	stripe_customer_id: string;
	stripe_subscription_id: string | null;
	tier: 'free' | 'premium';
	status: string;
	current_period_end: string | null;
}

export interface SupabaseAdminClient {
	getProfile(userId: string): Promise<ProfileRow | null>;
	getSubscription(userId: string): Promise<SubscriptionRow | null>;
	getSubscriptionByCustomerId(
		stripeCustomerId: string,
	): Promise<SubscriptionRow | null>;
	getUserIdFromToken(token: string): Promise<string | null>;
	insertIncompleteSubscription(input: {
		userId: string;
		stripeCustomerId: string;
	}): Promise<void>;
	upsertSubscription(row: SubscriptionUpsert): Promise<void>;
	deleteSubscription(userId: string): Promise<void>;
	deleteProfile(userId: string): Promise<void>;
	deleteAuthUser(userId: string): Promise<void>;
	/**
	 * Globally revoke every session (and refresh token) tied to a user's JWT.
	 * Used by account deletion as a defense-in-depth step so a leaked token
	 * can't outlive the account. Hits GoTrue `POST /logout?scope=global` with
	 * the user's own bearer token (there is no admin-by-id signout endpoint).
	 */
	signOutUser(token: string): Promise<void>;
	insertAuditLog(row: {
		event_type: string;
		stripe_customer_id: string | null;
		metadata?: Record<string, unknown>;
	}): Promise<void>;
	/**
	 * Idempotency guard for billing webhooks (ADA-308). Records a processed
	 * billing event id; returns `true` if newly recorded, `false` if it was
	 * already seen (a duplicate delivery that must not be reprocessed).
	 */
	recordBillingEvent(eventId: string): Promise<boolean>;
}

export function defaultSupabaseAdmin(): SupabaseAdminClient {
	const url = process.env.SUPABASE_URL;
	const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !serviceRoleKey) {
		throw new Error(
			'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. See ADA-254.',
		);
	}
	return new FetchSupabaseAdminClient(url, serviceRoleKey);
}

class FetchSupabaseAdminClient implements SupabaseAdminClient {
	constructor(
		private readonly url: string,
		private readonly serviceRoleKey: string,
	) {}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		return {
			apikey: this.serviceRoleKey,
			authorization: `Bearer ${this.serviceRoleKey}`,
			accept: 'application/json',
			...extra,
		};
	}

	async getProfile(userId: string): Promise<ProfileRow | null> {
		const params = new URLSearchParams({
			id: `eq.${userId}`,
			select: 'id,email,created_at',
		});
		const res = await fetch(
			`${this.url}/rest/v1/profiles?${params.toString()}`,
			{ headers: this.headers() },
		);
		if (!res.ok) {
			throw new Error(`supabaseAdmin.getProfile failed: ${res.status}`);
		}
		const rows = (await res.json()) as ProfileRow[];
		return rows[0] ?? null;
	}

	async getSubscription(userId: string): Promise<SubscriptionRow | null> {
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			select:
				'user_id,stripe_customer_id,stripe_subscription_id,tier,status,current_period_end,updated_at',
		});
		const res = await fetch(
			`${this.url}/rest/v1/subscriptions?${params.toString()}`,
			{ headers: this.headers() },
		);
		if (!res.ok) {
			throw new Error(`supabaseAdmin.getSubscription failed: ${res.status}`);
		}
		const rows = (await res.json()) as SubscriptionRow[];
		return rows[0] ?? null;
	}

	async deleteSubscription(userId: string): Promise<void> {
		const params = new URLSearchParams({ user_id: `eq.${userId}` });
		const res = await fetch(
			`${this.url}/rest/v1/subscriptions?${params.toString()}`,
			{ method: 'DELETE', headers: this.headers() },
		);
		if (!res.ok) {
			throw new Error(`supabaseAdmin.deleteSubscription failed: ${res.status}`);
		}
	}

	async deleteProfile(userId: string): Promise<void> {
		const params = new URLSearchParams({ id: `eq.${userId}` });
		const res = await fetch(
			`${this.url}/rest/v1/profiles?${params.toString()}`,
			{ method: 'DELETE', headers: this.headers() },
		);
		if (!res.ok) {
			throw new Error(`supabaseAdmin.deleteProfile failed: ${res.status}`);
		}
	}

	async deleteAuthUser(userId: string): Promise<void> {
		const res = await fetch(`${this.url}/auth/v1/admin/users/${userId}`, {
			method: 'DELETE',
			headers: this.headers(),
		});
		if (!res.ok) {
			throw new Error(`supabaseAdmin.deleteAuthUser failed: ${res.status}`);
		}
	}

	async signOutUser(token: string): Promise<void> {
		// GoTrue: POST /auth/v1/logout?scope=global with the user's own bearer
		// token revokes all of that user's sessions and refresh tokens across
		// every device. We pass the JWT the delete handler already verified.
		const res = await fetch(`${this.url}/auth/v1/logout?scope=global`, {
			method: 'POST',
			headers: {
				apikey: this.serviceRoleKey,
				authorization: `Bearer ${token}`,
			},
		});
		// 204 = signed out. Treat an already-invalid token (401) as success:
		// the goal (no usable session remains) is met either way.
		if (!res.ok && res.status !== 401) {
			throw new Error(`supabaseAdmin.signOutUser failed: ${res.status}`);
		}
	}

	async getSubscriptionByCustomerId(
		stripeCustomerId: string,
	): Promise<SubscriptionRow | null> {
		const params = new URLSearchParams({
			stripe_customer_id: `eq.${stripeCustomerId}`,
			select:
				'user_id,stripe_customer_id,stripe_subscription_id,tier,status,current_period_end,updated_at',
		});
		const res = await fetch(
			`${this.url}/rest/v1/subscriptions?${params.toString()}`,
			{ headers: this.headers() },
		);
		if (!res.ok) {
			throw new Error(
				`supabaseAdmin.getSubscriptionByCustomerId failed: ${res.status}`,
			);
		}
		const rows = (await res.json()) as SubscriptionRow[];
		return rows[0] ?? null;
	}

	async getUserIdFromToken(token: string): Promise<string | null> {
		// Consolidated verify (ADA-343). This client backs the low-traffic,
		// sensitive flows (checkout, billing portal, account subscription), so we
		// require a live GoTrue check (`confirmWithServer`): a deleted user or
		// revoked session must be rejected here, not accepted until token expiry.
		// The hot proxy path uses entitlement.ts's local-first client instead.
		return userIdFromToken(token, {
			confirmWithServer: true,
			env: {
				SUPABASE_URL: this.url,
				SUPABASE_SERVICE_ROLE_KEY: this.serviceRoleKey,
			},
		});
	}

	async insertIncompleteSubscription(input: {
		userId: string;
		stripeCustomerId: string;
	}): Promise<void> {
		const res = await fetch(`${this.url}/rest/v1/subscriptions`, {
			method: 'POST',
			headers: this.headers({
				'content-type': 'application/json',
				prefer: 'return=minimal',
			}),
			body: JSON.stringify({
				user_id: input.userId,
				stripe_customer_id: input.stripeCustomerId,
				tier: 'free',
				status: 'incomplete',
			}),
		});
		if (!res.ok) {
			throw new Error(
				`supabaseAdmin.insertIncompleteSubscription failed: ${res.status}`,
			);
		}
	}

	async upsertSubscription(row: SubscriptionUpsert): Promise<void> {
		const res = await fetch(`${this.url}/rest/v1/subscriptions`, {
			method: 'POST',
			headers: this.headers({
				'content-type': 'application/json',
				prefer: 'resolution=merge-duplicates,return=minimal',
			}),
			body: JSON.stringify(row),
		});
		if (!res.ok) {
			throw new Error(`supabaseAdmin.upsertSubscription failed: ${res.status}`);
		}
	}

	async insertAuditLog(row: {
		event_type: string;
		stripe_customer_id: string | null;
		metadata?: Record<string, unknown>;
	}): Promise<void> {
		const res = await fetch(`${this.url}/rest/v1/audit_log`, {
			method: 'POST',
			headers: this.headers({
				'content-type': 'application/json',
				prefer: 'return=minimal',
			}),
			body: JSON.stringify(row),
		});
		if (!res.ok) {
			throw new Error(`supabaseAdmin.insertAuditLog failed: ${res.status}`);
		}
	}

	async recordBillingEvent(eventId: string): Promise<boolean> {
		// INSERT ... ON CONFLICT DO NOTHING via PostgREST. With
		// `return=representation` the body holds the inserted rows — empty when
		// the id already existed, which is exactly our duplicate signal.
		const res = await fetch(`${this.url}/rest/v1/billing_event_log`, {
			method: 'POST',
			headers: this.headers({
				'content-type': 'application/json',
				prefer: 'resolution=ignore-duplicates,return=representation',
			}),
			body: JSON.stringify({ event_id: eventId }),
		});
		if (!res.ok) {
			throw new Error(`supabaseAdmin.recordBillingEvent failed: ${res.status}`);
		}
		const rows = (await res.json()) as unknown[];
		return Array.isArray(rows) && rows.length > 0;
	}
}
