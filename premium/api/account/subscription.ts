/**
 * GET /api/account/subscription
 *
 * Returns the caller's `subscriptions` row so the client can decide whether
 * to auto-resolve the hosted CORS proxy URL (ADA-273). Verifies the Supabase
 * JWT before touching the database. Returns `{ subscription: null }` (200)
 * when the user is authenticated but has no row yet — that's the common
 * free-tier shape.
 *
 * Logging discipline:
 *   DO log:    timestamp, user_id (post-verification), outcome.
 *   DO NOT log: tokens, Authorization headers, request body, subscription detail.
 *
 * Linear: ADA-273.
 */

import {
	defaultSupabaseAdmin,
	type SubscriptionRow,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';

// Edge runtime: Supabase REST + JWT verify are fetch-only and edge-compatible.
export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface SubscriptionDeps {
	admin?: SupabaseAdminClient;
	verifyJwt?: (token: string) => Promise<string | null>;
}

export interface SubscriptionResponseBody {
	subscription: {
		tier: string;
		status: string;
		current_period_end: string | null;
	} | null;
}

export default async function handler(request: Request): Promise<Response> {
	return handleSubscription(request);
}

export async function handleSubscription(
	request: Request,
	deps: SubscriptionDeps = {},
): Promise<Response> {
	if (request.method !== 'GET') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		logEvent({ userId: null, status: 401, note: 'missing_token' });
		return jsonResponse(401, { error: 'missing_token' });
	}

	let admin: SupabaseAdminClient;
	try {
		admin = deps.admin ?? defaultSupabaseAdmin();
	} catch (err) {
		logEvent({
			userId: null,
			status: 500,
			note: `server_misconfigured:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	const verifyJwt =
		deps.verifyJwt ?? ((t: string) => admin.getUserIdFromToken(t));
	const userId = await verifyJwt(token);
	if (!userId) {
		logEvent({ userId: null, status: 401, note: 'invalid_token' });
		return jsonResponse(401, { error: 'invalid_token' });
	}

	let row: SubscriptionRow | null;
	try {
		row = await admin.getSubscription(userId);
	} catch (err) {
		logEvent({
			userId,
			status: 500,
			note: `supabase_read_failed:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'subscription_read_failed' });
	}

	logEvent({ userId, status: 200 });
	const body: SubscriptionResponseBody = {
		subscription: row
			? {
					tier: row.tier,
					status: row.status,
					current_period_end: row.current_period_end,
				}
			: null,
	};
	return jsonResponse(200, body as unknown as Record<string, unknown>);
}

function extractBearer(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

interface LogFields {
	userId: string | null;
	status: number;
	note?: string;
}

function logEvent(fields: LogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-account-subscription',
			user_id: fields.userId,
			status: fields.status,
			...(fields.note ? { note: fields.note } : {}),
		}),
	);
}
