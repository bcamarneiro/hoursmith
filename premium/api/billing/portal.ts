/**
 * Polar customer-portal link for Hoursmith Premium.
 *
 * `POST /api/billing/portal` returns `{ url }` pointing at the Polar customer
 * portal for the calling user, where they can update a card, cancel, or
 * download invoices. The frontend redirects there (the /account button).
 *
 * Auth model: a valid Supabase JWT — NOT an active subscription. Past-due /
 * canceled users still need to manage billing.
 *
 * Failure modes:
 *   - missing/invalid JWT    → 401
 *   - no `subscriptions` row → 404 `no_billing_history`
 *   - Polar call fails       → 502 `polar_portal_failed`
 *   - missing env            → 500 `server_misconfigured`
 *
 * Logging: log user_id + Polar customer id (not PII). NEVER log the URL.
 *
 * Linear: ADA-294 (migrated from Stripe ADA-262).
 */

import { logger } from '../_lib/logger.js';
import { createPolarCustomerSession } from '../_lib/polarClient.js';
import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface PortalDeps {
	supabase?: SupabaseAdminClient;
	/** Inject the Polar customer-session creator (tests). */
	createCustomerSession?: (externalId: string) => Promise<{ url: string }>;
}

export default async function handler(request: Request): Promise<Response> {
	return handlePortal(request);
}

export async function handlePortal(
	request: Request,
	deps: PortalDeps = {},
): Promise<Response> {
	const start = Date.now();

	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		logPortal({
			userId: null,
			customerId: null,
			code: 'missing_token',
			status: 401,
			durationMs: Date.now() - start,
		});
		return jsonResponse(401, { error: 'missing_token' });
	}

	let supabase: SupabaseAdminClient;
	try {
		supabase = deps.supabase ?? defaultSupabaseAdmin();
	} catch (err) {
		logPortal({
			userId: null,
			customerId: null,
			code: 'server_misconfigured',
			status: 500,
			durationMs: Date.now() - start,
			detail: (err as Error).message,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	const userId = await supabase.getUserIdFromToken(token);
	if (!userId) {
		logPortal({
			userId: null,
			customerId: null,
			code: 'invalid_token',
			status: 401,
			durationMs: Date.now() - start,
		});
		return jsonResponse(401, { error: 'invalid_token' });
	}

	let subscription: Awaited<ReturnType<SupabaseAdminClient['getSubscription']>>;
	try {
		subscription = await supabase.getSubscription(userId);
	} catch (err) {
		logPortal({
			userId,
			customerId: null,
			code: 'subscription_read_failed',
			status: 500,
			durationMs: Date.now() - start,
			detail: (err as Error).message,
		});
		return jsonResponse(500, { error: 'subscription_read_failed' });
	}

	if (!subscription) {
		logPortal({
			userId,
			customerId: null,
			code: 'no_billing_history',
			status: 404,
			durationMs: Date.now() - start,
		});
		return jsonResponse(404, { error: 'no_billing_history' });
	}

	const createCustomerSession =
		deps.createCustomerSession ?? createPolarCustomerSession;
	let url: string;
	try {
		const result = await createCustomerSession(userId);
		url = result.url;
	} catch (err) {
		logPortal({
			userId,
			customerId: subscription.stripe_customer_id,
			code: 'polar_portal_failed',
			status: 502,
			durationMs: Date.now() - start,
			detail: (err as Error).message,
		});
		return jsonResponse(502, { error: 'polar_portal_failed' });
	}

	logPortal({
		userId,
		customerId: subscription.stripe_customer_id,
		code: 'ok',
		status: 200,
		durationMs: Date.now() - start,
	});
	return jsonResponse(200, { url });
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

interface PortalLogFields {
	userId: string | null;
	customerId: string | null;
	code: string;
	status: number;
	durationMs: number;
	detail?: string;
}

/** Structured log line. Scrubbed: no headers, no body, no portal URL. */
function logPortal(fields: PortalLogFields): void {
	logger.info('hoursmith-billing-portal', 'billing_portal', {
		user_id: fields.userId,
		polar_customer_id: fields.customerId,
		code: fields.code,
		status: fields.status,
		duration_ms: fields.durationMs,
		...(fields.detail ? { detail: fields.detail } : {}),
	});
}
