/**
 * Unit tests for the Polar webhook handler (ADA-294).
 *
 * The signature verifier and Supabase admin client are injected, so these
 * tests need no real HMAC secret and no network.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handlePolarWebhook } from '../webhook';

function makeRequest(
	rawBody: string,
	method = 'POST',
	headers: Record<string, string> = {},
): Request {
	return new Request('https://hoursmith.io/api/polar/webhook', {
		method,
		headers: {
			'content-type': 'application/json',
			// Default delivery id so the dedup guard has a key (ADA-308). Override
			// per-test to simulate replays of the same delivery.
			'webhook-id': 'evt_default',
			...headers,
		},
		body: method === 'POST' ? rawBody : undefined,
	});
}

function makeSupabase(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		upsertSubscription: vi.fn().mockResolvedValue(undefined),
		getSubscription: vi.fn().mockResolvedValue(null),
		getSubscriptionByCustomerId: vi.fn().mockResolvedValue(null),
		// Default: every delivery id is new (not a duplicate).
		recordBillingEvent: vi.fn().mockResolvedValue(true),
		...overrides,
	} as unknown as SupabaseAdminClient;
}

const accept = async () => true;
const SECRET = 'whsec_test';

// Product ids the webhook must recognise (ADA-453). Mirrors the checkout env.
const PRODUCT_ENV = {
	POLAR_PRODUCT_HOSTED: 'prod_hosted',
	POLAR_PRODUCT_LEAD: 'prod_lead',
};

function event(type: string, data: Record<string, unknown>): string {
	return JSON.stringify({ type, data });
}

const ACTIVE = {
	id: 'sub_1',
	status: 'active',
	product_id: 'prod_hosted',
	current_period_end: '2027-05-18T00:00:00Z',
	customer_id: 'cus_1',
	customer: { external_id: 'user-123' },
};

describe('handlePolarWebhook', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns 405 for non-POST', async () => {
		const res = await handlePolarWebhook(makeRequest('', 'GET'), {
			supabase: makeSupabase(),
			verify: accept,
			secret: SECRET,
		});
		expect(res.status).toBe(405);
	});

	it('returns 500 when the webhook secret is missing', async () => {
		const res = await handlePolarWebhook(
			makeRequest(event('subscription.active', ACTIVE)),
			{
				supabase: makeSupabase(),
				verify: accept,
				secret: undefined,
				// no POLAR_WEBHOOK_SECRET in test env
			},
		);
		expect(res.status).toBe(500);
	});

	it('returns 400 on a bad signature', async () => {
		const res = await handlePolarWebhook(
			makeRequest(event('subscription.active', ACTIVE)),
			{
				supabase: makeSupabase(),
				verify: async () => false,
				secret: SECRET,
			},
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_signature' });
	});

	it('returns 400 on a malformed body', async () => {
		const res = await handlePolarWebhook(makeRequest('not json'), {
			supabase: makeSupabase(),
			verify: accept,
			secret: SECRET,
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_payload' });
	});

	it('ignores non-subscription events', async () => {
		const supabase = makeSupabase();
		const res = await handlePolarWebhook(
			makeRequest(event('order.created', {})),
			{
				supabase,
				verify: accept,
				secret: SECRET,
			},
		);
		expect(res.status).toBe(200);
		expect(supabase.upsertSubscription).not.toHaveBeenCalled();
	});

	it('upserts premium/active on subscription.active', async () => {
		const supabase = makeSupabase();
		const res = await handlePolarWebhook(
			makeRequest(event('subscription.active', ACTIVE)),
			{
				supabase,
				verify: accept,
				secret: SECRET,
				env: PRODUCT_ENV,
			},
		);
		expect(res.status).toBe(200);
		expect(supabase.upsertSubscription).toHaveBeenCalledWith({
			user_id: 'user-123',
			stripe_customer_id: 'cus_1',
			stripe_subscription_id: 'sub_1',
			tier: 'premium',
			status: 'active',
			current_period_end: '2027-05-18T00:00:00Z',
		});
	});

	it('downgrades to free/canceled on subscription.revoked', async () => {
		const supabase = makeSupabase();
		await handlePolarWebhook(
			makeRequest(event('subscription.revoked', ACTIVE)),
			{
				supabase,
				verify: accept,
				secret: SECRET,
			},
		);
		expect(supabase.upsertSubscription).toHaveBeenCalledWith({
			user_id: 'user-123',
			stripe_customer_id: 'cus_1',
			stripe_subscription_id: 'sub_1',
			tier: 'free',
			status: 'canceled',
			current_period_end: null,
		});
	});

	it('keeps the user premium on subscription.canceled (access until period end)', async () => {
		const supabase = makeSupabase();
		await handlePolarWebhook(
			makeRequest(
				event('subscription.canceled', {
					...ACTIVE,
					cancel_at_period_end: true,
				}),
			),
			{ supabase, verify: accept, secret: SECRET, env: PRODUCT_ENV },
		);
		expect(supabase.upsertSubscription).toHaveBeenCalledWith(
			expect.objectContaining({ tier: 'premium', status: 'active' }),
		);
	});

	it('resolves the user via customer_id lookup when external_id is absent', async () => {
		const supabase = makeSupabase({
			getSubscriptionByCustomerId: vi
				.fn()
				.mockResolvedValue({ user_id: 'user-from-db' }),
		});
		await handlePolarWebhook(
			makeRequest(
				event('subscription.active', {
					id: 'sub_2',
					status: 'active',
					product_id: 'prod_lead',
					customer_id: 'cus_9',
				}),
			),
			{ supabase, verify: accept, secret: SECRET, env: PRODUCT_ENV },
		);
		expect(supabase.upsertSubscription).toHaveBeenCalledWith(
			expect.objectContaining({ user_id: 'user-from-db' }),
		);
	});

	it('returns 200 without writing when the user cannot be resolved', async () => {
		const supabase = makeSupabase();
		const res = await handlePolarWebhook(
			makeRequest(
				event('subscription.active', {
					id: 'sub_3',
					status: 'active',
					customer_id: 'cus_x',
				}),
			),
			{ supabase, verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(200);
		expect(supabase.upsertSubscription).not.toHaveBeenCalled();
	});

	it('records the delivery id and processes a first-seen event (ADA-308)', async () => {
		const supabase = makeSupabase();
		const res = await handlePolarWebhook(
			makeRequest(event('subscription.active', ACTIVE), 'POST', {
				'webhook-id': 'evt_111',
			}),
			{ supabase, verify: accept, secret: SECRET, env: PRODUCT_ENV },
		);
		expect(res.status).toBe(200);
		expect(supabase.recordBillingEvent).toHaveBeenCalledWith('evt_111');
		expect(supabase.upsertSubscription).toHaveBeenCalled();
	});

	it('ignores a duplicate delivery without re-upserting (ADA-308)', async () => {
		const supabase = makeSupabase({
			recordBillingEvent: vi.fn().mockResolvedValue(false),
		});
		const res = await handlePolarWebhook(
			makeRequest(event('subscription.active', ACTIVE), 'POST', {
				'webhook-id': 'evt_dup',
			}),
			{ supabase, verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(200);
		expect(supabase.recordBillingEvent).toHaveBeenCalledWith('evt_dup');
		expect(supabase.upsertSubscription).not.toHaveBeenCalled();
	});

	it('rejects a delivery with no webhook-id (ADA-455)', async () => {
		const supabase = makeSupabase();
		// Build a request WITHOUT the default webhook-id header.
		const req = new Request('https://hoursmith.io/api/polar/webhook', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: event('subscription.active', ACTIVE),
		});
		const res = await handlePolarWebhook(req, {
			supabase,
			verify: accept,
			secret: SECRET,
			env: PRODUCT_ENV,
		});
		expect(res.status).toBe(400);
		expect(supabase.recordBillingEvent).not.toHaveBeenCalled();
		expect(supabase.upsertSubscription).not.toHaveBeenCalled();
	});

	it('treats production with POLAR_SERVER unset as wrong environment (ADA-455)', async () => {
		const supabase = makeSupabase();
		const res = await handlePolarWebhook(
			makeRequest(event('subscription.active', ACTIVE)),
			{
				supabase,
				verify: accept,
				secret: SECRET,
				// POLAR_SERVER unset ⇒ defaultPolarConfig resolves to sandbox, so a
				// prod deploy is cross-wired and the event must be ignored.
				env: { VERCEL_ENV: 'production', ...PRODUCT_ENV },
			},
		);
		expect(res.status).toBe(200);
		expect(supabase.recordBillingEvent).not.toHaveBeenCalled();
		expect(supabase.upsertSubscription).not.toHaveBeenCalled();
	});

	it('rejects a wrong-environment event before any write (ADA-308)', async () => {
		const supabase = makeSupabase();
		const res = await handlePolarWebhook(
			makeRequest(event('subscription.active', ACTIVE)),
			{
				supabase,
				verify: accept,
				secret: SECRET,
				env: { VERCEL_ENV: 'production', POLAR_SERVER: 'sandbox' },
			},
		);
		expect(res.status).toBe(200);
		expect(supabase.recordBillingEvent).not.toHaveBeenCalled();
		expect(supabase.upsertSubscription).not.toHaveBeenCalled();
	});

	it('processes normally when the environment matches (ADA-308)', async () => {
		const supabase = makeSupabase();
		await handlePolarWebhook(
			makeRequest(event('subscription.active', ACTIVE)),
			{
				supabase,
				verify: accept,
				secret: SECRET,
				env: {
					VERCEL_ENV: 'production',
					POLAR_SERVER: 'production',
					...PRODUCT_ENV,
				},
			},
		);
		expect(supabase.upsertSubscription).toHaveBeenCalled();
	});

	it('does not grant premium for an unrecognised product_id (ADA-453)', async () => {
		const supabase = makeSupabase();
		const res = await handlePolarWebhook(
			makeRequest(
				event('subscription.active', { ...ACTIVE, product_id: 'prod_other' }),
			),
			{ supabase, verify: accept, secret: SECRET, env: PRODUCT_ENV },
		);
		expect(res.status).toBe(200);
		expect(supabase.upsertSubscription).not.toHaveBeenCalled();
	});

	it('does not grant premium when product_id is absent (ADA-453)', async () => {
		const supabase = makeSupabase();
		const { product_id: _omit, ...noProduct } = ACTIVE;
		const res = await handlePolarWebhook(
			makeRequest(event('subscription.active', noProduct)),
			{ supabase, verify: accept, secret: SECRET, env: PRODUCT_ENV },
		);
		expect(res.status).toBe(200);
		expect(supabase.upsertSubscription).not.toHaveBeenCalled();
	});

	it('does not grant premium when product env is unconfigured (fails closed, ADA-453)', async () => {
		const supabase = makeSupabase();
		const res = await handlePolarWebhook(
			makeRequest(event('subscription.active', ACTIVE)),
			{ supabase, verify: accept, secret: SECRET, env: {} },
		);
		expect(res.status).toBe(200);
		expect(supabase.upsertSubscription).not.toHaveBeenCalled();
	});

	it('still downgrades on revoke regardless of product_id (ADA-453)', async () => {
		const supabase = makeSupabase();
		await handlePolarWebhook(
			makeRequest(
				event('subscription.revoked', { ...ACTIVE, product_id: 'prod_other' }),
			),
			{ supabase, verify: accept, secret: SECRET, env: PRODUCT_ENV },
		);
		expect(supabase.upsertSubscription).toHaveBeenCalledWith(
			expect.objectContaining({ tier: 'free', status: 'canceled' }),
		);
	});

	it('ignores a stale event (older than the stored row)', async () => {
		const supabase = makeSupabase({
			getSubscription: vi
				.fn()
				.mockResolvedValue({ updated_at: '2026-02-01T00:00:00Z' }),
		});
		const res = await handlePolarWebhook(
			makeRequest(
				event('subscription.updated', {
					...ACTIVE,
					modified_at: '2026-01-01T00:00:00Z',
				}),
			),
			{ supabase, verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(200);
		expect(supabase.upsertSubscription).not.toHaveBeenCalled();
	});
});
