/**
 * Polar webhook handler for Hoursmith Premium.
 *
 * Receives subscription lifecycle events from Polar and keeps the
 * `public.subscriptions` table in sync. Replaces the Stripe webhook (ADA-261).
 *
 * Endpoint: POST /api/polar/webhook
 * Region:   fra1 (GDPR residency, matches vercel.json).
 *
 * Security model (Standard Webhooks):
 *   1. Read the RAW body (`req.text()`) — parsing first would break HMAC verify.
 *   2. Verify the `webhook-signature` against `POLAR_WEBHOOK_SECRET`.
 *   3. Only then act. Verification failures return 400 with no DB write.
 *
 * Idempotency / ordering:
 *   - Upserts are keyed on `subscriptions.user_id`, so replay is safe.
 *   - We compare `data.modified_at` to the row's `updated_at`; older events are
 *     skipped to defend against out-of-order delivery.
 *   - Polar retries non-2xx, so we always return 2xx unless the event is
 *     genuinely unprocessable (bad signature / malformed body).
 *
 * Access model: a subscription canceled with `cancel_at_period_end` keeps
 * `active` status until the period ends, when Polar fires `subscription.revoked`.
 * So only `revoked` downgrades the user to free — `canceled` leaves access on.
 *
 * Logging discipline: log event type, user_id, outcome. Never log raw body,
 * signature, or customer-facing PII.
 *
 * Linear: ADA-294.
 */

import { verifyPolarWebhook } from '../_lib/polarClient.js';
import {
	defaultSupabaseAdmin,
	type SubscriptionUpsert,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

type Outcome =
	| 'ok'
	| 'ignored_unknown_event'
	| 'ignored_stale_event'
	| 'ignored_duplicate_event'
	| 'ignored_wrong_environment'
	| 'missing_signature'
	| 'invalid_signature'
	| 'invalid_payload'
	| 'server_misconfigured'
	| 'missing_user_id'
	| 'upsert_failed';

/** The slice of the Polar subscription object we depend on. */
interface PolarSubscriptionData {
	id: string;
	status: string;
	current_period_end?: string | null;
	modified_at?: string | null;
	customer_id?: string;
	customer?: { external_id?: string | null } | null;
	metadata?: Record<string, unknown> | null;
}

interface PolarEvent {
	type: string;
	data: PolarSubscriptionData;
}

export interface PolarWebhookDeps {
	supabase?: SupabaseAdminClient;
	/** Injectable signature verifier (tests bypass real HMAC). */
	verify?: (
		rawBody: string,
		headers: Headers,
		secret: string,
	) => Promise<boolean>;
	/** Injectable secret (tests). Defaults to POLAR_WEBHOOK_SECRET. */
	secret?: string;
	/** Injectable env (tests). Defaults to `process.env` — for the env guard. */
	env?: Partial<Record<string, string | undefined>>;
}

/**
 * Environment guard (ADA-308). Polar's payload doesn't reliably expose the
 * event environment, so we assert the deployment's configured `POLAR_SERVER`
 * matches the deployment mode: a production deployment must talk to Polar
 * production. A mismatch means a sandbox⇄prod cross-wire — we ignore the event
 * rather than mutate live subscription state from the wrong environment.
 */
export function isWrongEnvironment(
	env: Partial<Record<string, string | undefined>>,
): boolean {
	return (
		env.VERCEL_ENV === 'production' &&
		!!env.POLAR_SERVER &&
		env.POLAR_SERVER !== 'production'
	);
}

export default async function handler(request: Request): Promise<Response> {
	return handlePolarWebhook(request);
}

export async function handlePolarWebhook(
	request: Request,
	deps: PolarWebhookDeps = {},
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const secret = deps.secret ?? process.env.POLAR_WEBHOOK_SECRET;
	if (!secret) {
		logWebhook({
			eventType: null,
			userId: null,
			outcome: 'server_misconfigured',
			status: 500,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	// Raw body MUST be the unparsed string — parsing breaks HMAC verification.
	const rawBody = await request.text();

	const verify = deps.verify ?? verifyPolarWebhook;
	let valid = false;
	try {
		valid = await verify(rawBody, request.headers, secret);
	} catch {
		valid = false;
	}
	if (!valid) {
		logWebhook({
			eventType: null,
			userId: null,
			outcome: 'invalid_signature',
			status: 400,
		});
		return jsonResponse(400, { error: 'invalid_signature' });
	}

	let event: PolarEvent;
	try {
		event = JSON.parse(rawBody) as PolarEvent;
	} catch {
		logWebhook({
			eventType: null,
			userId: null,
			outcome: 'invalid_payload',
			status: 400,
		});
		return jsonResponse(400, { error: 'invalid_payload' });
	}

	let supabase: SupabaseAdminClient;
	try {
		supabase = deps.supabase ?? defaultSupabaseAdmin();
	} catch {
		logWebhook({
			eventType: event.type,
			userId: null,
			outcome: 'server_misconfigured',
			status: 500,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	if (!event.type?.startsWith('subscription.')) {
		logWebhook({
			eventType: event.type,
			userId: null,
			outcome: 'ignored_unknown_event',
			status: 200,
		});
		return jsonResponse(200, { received: true });
	}

	// Environment guard (ADA-308): reject a wrong-environment delivery before
	// touching subscription state. 200 so Polar doesn't retry a misroute.
	const env = deps.env ?? process.env;
	if (isWrongEnvironment(env)) {
		logWebhook({
			eventType: event.type,
			userId: null,
			outcome: 'ignored_wrong_environment',
			status: 200,
		});
		return jsonResponse(200, { received: true });
	}

	try {
		// Idempotency guard (ADA-308): the Standard Webhooks `webhook-id` is the
		// per-delivery key. A duplicate delivery is short-circuited so we don't
		// re-run the upsert. (verifyPolarWebhook already required this header.)
		const webhookId = request.headers.get('webhook-id');
		if (webhookId) {
			const isNew = await supabase.recordBillingEvent(webhookId);
			if (!isNew) {
				logWebhook({
					eventType: event.type,
					userId: null,
					outcome: 'ignored_duplicate_event',
					status: 200,
				});
				return jsonResponse(200, { received: true });
			}
		}
		return await handleSubscription(event, supabase);
	} catch (err) {
		logWebhook({
			eventType: event.type,
			userId: null,
			outcome: 'upsert_failed',
			status: 500,
			note: (err as Error).message,
		});
		// 500 → Polar retries; the upsert is idempotent.
		return jsonResponse(500, { error: 'internal_error' });
	}
}

async function handleSubscription(
	event: PolarEvent,
	supabase: SupabaseAdminClient,
): Promise<Response> {
	const data = event.data;
	const userId = await resolveUserId(data, supabase);
	if (!userId) {
		logWebhook({
			eventType: event.type,
			userId: null,
			outcome: 'missing_user_id',
			status: 200,
		});
		return jsonResponse(200, { received: true });
	}

	// Defend against out-of-order delivery using the resource's modified_at.
	if (data.modified_at) {
		const existing = await supabase.getSubscription(userId);
		if (
			existing &&
			Date.parse(existing.updated_at) > Date.parse(data.modified_at)
		) {
			logWebhook({
				eventType: event.type,
				userId,
				outcome: 'ignored_stale_event',
				status: 200,
			});
			return jsonResponse(200, { received: true });
		}
	}

	const customerId = data.customer_id ?? '';
	const revoked = event.type === 'subscription.revoked';
	const upsert: SubscriptionUpsert = revoked
		? {
				user_id: userId,
				stripe_customer_id: customerId,
				stripe_subscription_id: data.id,
				tier: 'free',
				status: 'canceled',
				current_period_end: null,
			}
		: {
				user_id: userId,
				stripe_customer_id: customerId,
				stripe_subscription_id: data.id,
				tier: 'premium',
				status: normaliseStatus(data.status),
				current_period_end: data.current_period_end ?? null,
			};

	await supabase.upsertSubscription(upsert);
	logWebhook({
		eventType: event.type,
		userId,
		outcome: 'ok',
		status: 200,
		resultingStatus: upsert.status,
		resultingTier: upsert.tier,
	});
	return jsonResponse(200, { received: true });
}

/**
 * Resolve our `user_id`. Checkout sets `customer_external_id = userId`, so
 * Polar echoes it on `data.customer.external_id`. Fall back to subscription
 * `metadata.user_id`, then to a lookup by Polar customer id.
 */
async function resolveUserId(
	data: PolarSubscriptionData,
	supabase: SupabaseAdminClient,
): Promise<string | null> {
	const fromCustomer = data.customer?.external_id;
	if (fromCustomer) return fromCustomer;
	const fromMetadata = data.metadata?.user_id;
	if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata;
	if (data.customer_id) {
		const existing = await supabase.getSubscriptionByCustomerId(
			data.customer_id,
		);
		return existing?.user_id ?? null;
	}
	return null;
}

/** Clamp Polar's subscription status onto the values our DB CHECK accepts. */
function normaliseStatus(status: string): SubscriptionUpsert['status'] {
	switch (status) {
		case 'active':
		case 'past_due':
		case 'canceled':
		case 'incomplete':
		case 'trialing':
		case 'unpaid':
			return status;
		case 'incomplete_expired':
			return 'canceled';
		default:
			return 'incomplete';
	}
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

interface WebhookLogFields {
	eventType: string | null;
	userId: string | null;
	outcome: Outcome;
	status: number;
	resultingStatus?: SubscriptionUpsert['status'];
	resultingTier?: SubscriptionUpsert['tier'];
	note?: string;
}

function logWebhook(fields: WebhookLogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-polar-webhook',
			event_type: fields.eventType,
			user_id: fields.userId,
			outcome: fields.outcome,
			status: fields.status,
			...(fields.resultingStatus
				? { resulting_status: fields.resultingStatus }
				: {}),
			...(fields.resultingTier ? { resulting_tier: fields.resultingTier } : {}),
			...(fields.note ? { note: fields.note } : {}),
		}),
	);
}
