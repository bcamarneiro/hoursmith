/**
 * Unit tests for the association webhook handler (ADA-640).
 *
 * The HMAC verifier and Supabase admin client are injected, so these
 * tests need no real shared secret and no network.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handleAssociationWebhook, verifyHmac } from '../webhook';

// --- Helpers ---

/** Compute an HMAC-SHA256 hex signature (WebCrypto async). */
async function sign(body: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sigBuf = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(body),
	);
	const bytes = new Uint8Array(sigBuf);
	let hex = '';
	for (const b of bytes) hex += b.toString(16).padStart(2, '0');
	return hex;
}

/** Build a POST request with a valid HMAC signature for body + secret. */
async function signedRequest(body: string, secret: string): Promise<Request> {
	const sig = await sign(body, secret);
	return new Request('https://hoursmith.io/api/association/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-signature-256': sig,
		},
		body,
	});
}

/**
 * Build a request with the verifier bypassed via `verify: accept`.
 * These tests don't need real signatures — the injectable verifier
 * that always returns true lets us test business logic independently.
 */
function bypassRequest(
	body: string,
	method = 'POST',
	headers: Record<string, string> = {},
): Request {
	return new Request('https://hoursmith.io/api/association/webhook', {
		method,
		headers: {
			'content-type': 'application/json',
			'x-signature-256': 'bypass',
			...headers,
		},
		body: method === 'POST' ? body : undefined,
	});
}

function makeSupabase(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		upsertSubscription: vi.fn().mockResolvedValue(undefined),
		getSubscription: vi.fn().mockResolvedValue(null),
		getSubscriptionByCustomerId: vi.fn().mockResolvedValue(null),
		recordBillingEvent: vi.fn().mockResolvedValue(true),
		upsertAssociations: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as SupabaseAdminClient;
}

const accept = async () => true;
const SECRET = 'whsec_test_association';

function payload(data: Record<string, unknown>): string {
	return JSON.stringify(data);
}

const ASSOCIATION = {
	user_id: 'user-123',
	external_source: 'calendar',
	external_id: 'evt_abc123',
	issue_key: 'ADA-42',
};

// --- Tests ---

describe('handleAssociationWebhook', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns 405 for non-POST', async () => {
		const res = await handleAssociationWebhook(
			bypassRequest(payload(ASSOCIATION), 'GET'),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(405);
	});

	it('returns 500 when the webhook secret is missing', async () => {
		const res = await handleAssociationWebhook(
			bypassRequest(payload(ASSOCIATION)),
			{
				supabase: makeSupabase(),
				verify: accept,
				secret: undefined,
			},
		);
		expect(res.status).toBe(500);
	});

	it('returns 401 on a bad signature', async () => {
		// No injectable verifier bypass — real verifyHmac with a junk signature.
		const res = await handleAssociationWebhook(
			bypassRequest(payload(ASSOCIATION)),
			{ supabase: makeSupabase(), secret: SECRET },
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'invalid_signature' });
	});

	it('returns 401 on a missing signature header', async () => {
		const res = await handleAssociationWebhook(
			bypassRequest(payload(ASSOCIATION), 'POST', {
				'x-signature-256': '',
			}),
			{ supabase: makeSupabase(), secret: SECRET },
		);
		expect(res.status).toBe(401);
	});

	it('returns 400 on a malformed body', async () => {
		const res = await handleAssociationWebhook(
			bypassRequest('not json'),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_payload' });
	});

	it('returns 400 on a missing required field', async () => {
		const res = await handleAssociationWebhook(
			bypassRequest(payload({ user_id: 'u1', external_source: 'cal' })),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 on an empty user_id', async () => {
		const res = await handleAssociationWebhook(
			bypassRequest(
				payload({
					user_id: '',
					external_source: 'cal',
					external_id: 'e1',
					issue_key: 'ADA-1',
				}),
			),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 when body is a plain string', async () => {
		const res = await handleAssociationWebhook(
			bypassRequest('"just a string"'),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 when body is null', async () => {
		const res = await handleAssociationWebhook(
			bypassRequest('null'),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('upserts a single association record', async () => {
		const supabase = makeSupabase();
		const body = payload(ASSOCIATION);
		const req = await signedRequest(body, SECRET);
		const res = await handleAssociationWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, associated: 1 });
		expect(supabase.upsertAssociations).toHaveBeenCalledOnce();
		const called = (
			supabase.upsertAssociations as ReturnType<typeof vi.fn>
		).mock.calls[0][0];
		expect(called).toHaveLength(1);
		expect(called[0]).toMatchObject({
			user_id: 'user-123',
			external_source: 'calendar',
			external_id: 'evt_abc123',
			issue_key: 'ADA-42',
		});
	});

	it('upserts a batch of association records', async () => {
		const supabase = makeSupabase();
		const batch = [
			{
				user_id: 'user-1',
				external_source: 'gitlab',
				external_id: 'commit_001',
				issue_key: 'ADA-10',
			},
			{
				user_id: 'user-1',
				external_source: 'gitlab',
				external_id: 'commit_002',
				issue_key: 'ADA-11',
			},
		];
		const body = JSON.stringify(batch);
		const req = await signedRequest(body, SECRET);
		const res = await handleAssociationWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, associated: 2 });
	});

	it('includes optional fields when provided', async () => {
		const supabase = makeSupabase();
		const body = payload({
			...ASSOCIATION,
			issue_summary: 'Fix the login bug',
			title_pattern: 'Standup:*',
			event_time: '2026-07-30T12:00:00Z',
		});
		const req = await signedRequest(body, SECRET);
		const res = await handleAssociationWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(200);
		const called = (
			supabase.upsertAssociations as ReturnType<typeof vi.fn>
		).mock.calls[0][0];
		expect(called[0]).toMatchObject({
			issue_summary: 'Fix the login bug',
			title_pattern: 'Standup:*',
			event_time: '2026-07-30T12:00:00Z',
		});
	});

	it('omits empty string optional fields', async () => {
		const supabase = makeSupabase();
		const body = payload({
			...ASSOCIATION,
			issue_summary: '',
			title_pattern: '',
			event_time: '',
		});
		const req = await signedRequest(body, SECRET);
		const res = await handleAssociationWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(200);
		const called = (
			supabase.upsertAssociations as ReturnType<typeof vi.fn>
		).mock.calls[0][0];
		expect(called[0].issue_summary).toBeUndefined();
		expect(called[0].title_pattern).toBeUndefined();
		expect(called[0].event_time).toBeUndefined();
	});

	it('returns 502 when the DB upsert fails', async () => {
		const supabase = makeSupabase({
			upsertAssociations: vi
				.fn()
				.mockRejectedValue(new Error('connection refused')),
		});
		const body = payload(ASSOCIATION);
		const req = await signedRequest(body, SECRET);
		const res = await handleAssociationWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'db_error' });
	});
});

describe('verifyHmac', () => {
	it('accepts a correctly computed signature', async () => {
		const body = JSON.stringify({ hello: 'world' });
		const secret = 'my-secret-key';
		const sig = await sign(body, secret);
		const result = await verifyHmac(body, sig, secret);
		expect(result).toBe(true);
	});

	it('rejects a tampered body', async () => {
		const secret = 'my-secret-key';
		const sig = await sign(JSON.stringify({ a: 1 }), secret);
		const result = await verifyHmac(JSON.stringify({ a: 2 }), sig, secret);
		expect(result).toBe(false);
	});

	it('rejects a wrong secret', async () => {
		const body = JSON.stringify({ hello: 'world' });
		const sig = await sign(body, 'secret-a');
		const result = await verifyHmac(body, sig, 'secret-b');
		expect(result).toBe(false);
	});

	it('returns false on an empty signature', async () => {
		const result = await verifyHmac('body', '', 'secret');
		expect(result).toBe(false);
	});

	it('returns false on crypto error (empty secret)', async () => {
		const result = await verifyHmac('body', 'sig', '');
		expect(result).toBe(false);
	});
});
