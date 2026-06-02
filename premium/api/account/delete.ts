/**
 * GDPR Article 17 — right to erasure.
 *
 * `POST /api/account/delete` permanently removes a Hoursmith account:
 *   1. Verifies the Supabase JWT.
 *   2. Cancels any active Stripe subscription (immediate, no proration).
 *   3. Deletes the `subscriptions` row.
 *   4. Deletes the `profiles` row.
 *   5. Deletes the `auth.users` row via Supabase Admin API.
 *   6. Writes an `audit_log` event keyed by stripe_customer_id only.
 *
 * Returns 204 on success; the frontend signs the user out and redirects.
 *
 * Logging discipline (compliance-critical):
 *   DO log:    timestamp, event type, success/error code, stripe_customer_id.
 *   DO NOT log: email, user_id, profile contents, JWT.
 *
 * Note on the auth check: we verify the JWT directly (we do NOT require an
 * active subscription) — a canceled or past_due user must still be able to
 * delete their account.
 *
 * Linear: ADA-263.
 */

import { logAuditEvent } from '../_lib/auditLog.js';
import { cancelPolarSubscription } from '../_lib/polarClient.js';
import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface DeleteDeps {
	admin?: SupabaseAdminClient;
	/** Inject the Polar subscription canceller (tests). */
	cancelSubscription?: (subscriptionId: string) => Promise<void>;
	verifyJwt?: (token: string) => Promise<string | null>;
}

export default async function handler(request: Request): Promise<Response> {
	return handleDelete(request);
}

export async function handleDelete(
	request: Request,
	deps: DeleteDeps = {},
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		logEvent({ event: 'account_delete', status: 401, note: 'missing_token' });
		return jsonResponse(401, { error: 'missing_token' });
	}

	let admin: SupabaseAdminClient;
	try {
		admin = deps.admin ?? defaultSupabaseAdmin();
	} catch (err) {
		logEvent({
			event: 'account_delete',
			status: 500,
			note: 'server_misconfigured',
		});
		return jsonResponse(500, {
			error: 'server_misconfigured',
			detail: (err as Error).message,
		});
	}

	const verifyJwt = deps.verifyJwt ?? makeJwtVerifier();
	const userId = await verifyJwt(token);
	if (!userId) {
		logEvent({ event: 'account_delete', status: 401, note: 'invalid_token' });
		return jsonResponse(401, { error: 'invalid_token' });
	}

	// Read subscription before we delete anything — we need stripe_customer_id
	// for the audit log even if the Supabase rows go away.
	const subscription = await admin.getSubscription(userId).catch(() => null);
	const stripeCustomerId = subscription?.stripe_customer_id ?? null;

	// Cancel the Polar subscription if there is an active one. We deliberately
	// do not block account deletion on Polar — if Polar is down or the
	// subscription is in a weird state, the user still gets erased. The audit
	// log captures the failure so finance can reconcile manually.
	const cancelSubscription = deps.cancelSubscription ?? cancelPolarSubscription;
	const cancelMeta: Record<string, unknown> = {};
	if (
		subscription?.stripe_subscription_id &&
		subscription.status === 'active'
	) {
		try {
			await cancelSubscription(subscription.stripe_subscription_id);
			cancelMeta.polar_cancel = 'ok';
		} catch (err) {
			cancelMeta.polar_cancel = 'error';
			cancelMeta.polar_error = (err as Error).message;
			logEvent({
				event: 'account_delete',
				status: 0,
				note: 'polar_cancel_failed',
			});
		}
	}

	// Hard-delete: subscriptions -> profiles -> auth.users.
	// `profiles.id` has `on delete cascade` against auth.users, and
	// `subscriptions.user_id` cascades against profiles, so deleting auth.users
	// alone would suffice. We still issue the explicit deletes so this code is
	// readable and works against any future schema where cascades are loosened.
	try {
		await admin.deleteSubscription(userId);
		await admin.deleteProfile(userId);
		await admin.deleteAuthUser(userId);
	} catch (err) {
		logEvent({
			event: 'account_delete',
			status: 500,
			note: 'supabase_delete_failed',
		});
		// Intentionally do NOT write an audit log here — leaving it unlogged
		// keeps a retry idempotent and prevents a "deleted" record for a user
		// who was not actually deleted.
		return jsonResponse(500, {
			error: 'delete_failed',
			detail: (err as Error).message,
		});
	}

	// Defense-in-depth (ADA-313): deleting auth.users already cascades the
	// user's sessions in GoTrue, but we ALSO globally sign the token out so a
	// JWT leaked before deletion (e.g. via third-party XSS) is rejected by
	// Supabase REST immediately rather than living until natural expiry.
	// Best-effort: the account is already gone and is the source of truth, so a
	// revocation failure is logged but never turns a successful delete into a
	// 500 or blocks the audit log below.
	try {
		await admin.signOutUser(token);
	} catch (err) {
		logEvent({
			event: 'account_delete',
			status: 0,
			note: `global_signout_failed:${(err as Error).message}`,
		});
	}

	try {
		await logAuditEvent('account_deleted', stripeCustomerId, cancelMeta, admin);
	} catch (err) {
		// Audit log failure is non-fatal: the user is already deleted. Surface
		// it to function logs so ops can backfill.
		logEvent({
			event: 'account_delete',
			status: 204,
			note: `audit_log_failed:${(err as Error).message}`,
		});
	}

	logEvent({ event: 'account_delete', status: 204 });
	return new Response(null, { status: 204 });
}

function extractBearer(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}

function makeJwtVerifier(): (token: string) => Promise<string | null> {
	const url = process.env.SUPABASE_URL;
	const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !serviceRoleKey) {
		// Surface as 401 rather than crashing; default factories above already
		// surfaced the misconfig as 500 if env was missing.
		return async () => null;
	}
	return async (token: string): Promise<string | null> => {
		const res = await fetch(`${url}/auth/v1/user`, {
			headers: {
				apikey: serviceRoleKey,
				authorization: `Bearer ${token}`,
			},
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { id?: string } | null;
		return body?.id ?? null;
	};
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

interface LogFields {
	event: string;
	status: number;
	note?: string;
}

function logEvent(fields: LogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-account',
			event: fields.event,
			status: fields.status,
			...(fields.note ? { note: fields.note } : {}),
		}),
	);
}
