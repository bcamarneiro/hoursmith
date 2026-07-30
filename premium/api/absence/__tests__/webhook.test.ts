/**
 * Unit tests for the absence webhook handler (ADA-645).
 *
 * HMAC verifier and Supabase admin client are injected, so these
 * tests need no real shared secret and no network.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handleAbsenceWebhook, verifyHmac } from '../webhook';

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
	return new Request('https://hoursmith.io/api/absence/webhook', {
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
 * Tests business logic independently of real HMAC.
 */
function bypassRequest(
	body: string,
	method = 'POST',
	headers: Record<string, string> = {},
): Request {
	return new Request('https://hoursmith.io/api/absence/webhook', {
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
		upsertUserAbsences: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as SupabaseAdminClient;
}

const accept = async () => true;
const SECRET = 'whsec_absence_secret';

function payload(data: Record<string, unknown>): string {
	return JSON.stringify(data);
}

const ABSENCE = {
	user_id: 'd7e9b4c1-0000-4000-8000-000000000001',
	absence_date: '2026-08-15',
	kind: 'vacation',
	reason: 'Summer holiday',
};

// --- Tests ---

describe('handleAbsenceWebhook', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns 405 for non-POST', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest(payload(ABSENCE), 'GET'),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(405);
	});

	it('returns 500 when the webhook secret is missing', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest(payload(ABSENCE)),
			{
				supabase: makeSupabase(),
				verify: accept,
				secret: undefined,
			},
		);
		expect(res.status).toBe(500);
		const json = (await res.json()) as Record<string, unknown>;
		expect(json.error).toBe('server_misconfigured');
	});

	it('returns 401 on a bad signature', async () => {
		// No injectable verifier bypass — real verifyHmac with a junk sig.
		const res = await handleAbsenceWebhook(
			bypassRequest(payload(ABSENCE)),
			{ supabase: makeSupabase(), secret: SECRET },
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'invalid_signature' });
	});

	it('returns 401 on a missing signature header', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest(payload(ABSENCE), 'POST', {
				'x-signature-256': '',
			}),
			{ supabase: makeSupabase(), secret: SECRET },
		);
		expect(res.status).toBe(401);
	});

	it('returns 400 on a malformed body', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest('not json'),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_payload' });
	});

	it('returns 400 on a missing required field (no reason)', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest(payload({
				user_id: ABSENCE.user_id,
				absence_date: ABSENCE.absence_date,
				kind: ABSENCE.kind,
				// reason missing
			})),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 on an empty user_id', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest(payload({ ...ABSENCE, user_id: '' })),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 on an empty absence_date', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest(payload({ ...ABSENCE, absence_date: '' })),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 on a bad date format', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest(payload({ ...ABSENCE, absence_date: 'August 15 2026' })),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 on an invalid kind', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest(payload({ ...ABSENCE, kind: 'maternity' })),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 on an empty reason', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest(payload({ ...ABSENCE, reason: '' })),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 when body is a plain string', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest('"just a string"'),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 when body is null', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest('null'),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 for an empty array', async () => {
		const res = await handleAbsenceWebhook(
			bypassRequest('[]'),
			{ supabase: makeSupabase(), verify: accept, secret: SECRET },
		);
		expect(res.status).toBe(400);
	});

	it('upserts a single absence record', async () => {
		const supabase = makeSupabase();
		const body = payload(ABSENCE);
		const req = await signedRequest(body, SECRET);
		const res = await handleAbsenceWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, synced: 1 });
		expect(supabase.upsertUserAbsences).toHaveBeenCalledOnce();
		const called = (
			supabase.upsertUserAbsences as ReturnType<typeof vi.fn>
		).mock.calls[0][0];
		expect(called).toHaveLength(1);
		expect(called[0]).toMatchObject({
			user_id: ABSENCE.user_id,
			absence_date: '2026-08-15',
			kind: 'vacation',
			reason: 'Summer holiday',
			provider_id: null,
		});
	});

	it('upserts a batch of absence records', async () => {
		const supabase = makeSupabase();
		const batch = [
			{
				user_id: 'd7e9b4c1-0000-4000-8000-000000000001',
				absence_date: '2026-08-15',
				kind: 'vacation',
				reason: 'Beach week',
			},
			{
				user_id: 'd7e9b4c1-0000-4000-8000-000000000001',
				absence_date: '2026-08-16',
				kind: 'vacation',
				reason: 'Beach week',
			},
		];
		const body = JSON.stringify(batch);
		const req = await signedRequest(body, SECRET);
		const res = await handleAbsenceWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, synced: 2 });
	});

	it('includes optional provider_id when provided', async () => {
		const supabase = makeSupabase();
		const body = payload({
			...ABSENCE,
			provider_id: 'abc123-provider',
		});
		const req = await signedRequest(body, SECRET);
		const res = await handleAbsenceWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(200);
		const called = (
			supabase.upsertUserAbsences as ReturnType<typeof vi.fn>
		).mock.calls[0][0];
		expect(called[0].provider_id).toBe('abc123-provider');
	});

	it('sets provider_id to null when empty string', async () => {
		const supabase = makeSupabase();
		const body = payload({ ...ABSENCE, provider_id: '' });
		const req = await signedRequest(body, SECRET);
		const res = await handleAbsenceWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(200);
		const called = (
			supabase.upsertUserAbsences as ReturnType<typeof vi.fn>
		).mock.calls[0][0];
		expect(called[0].provider_id).toBeNull();
	});

	it('buries external_id in metadata', async () => {
		const supabase = makeSupabase();
		const body = payload({ ...ABSENCE, external_id: 'ext-999' });
		const req = await signedRequest(body, SECRET);
		const res = await handleAbsenceWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(200);
		const called = (
			supabase.upsertUserAbsences as ReturnType<typeof vi.fn>
		).mock.calls[0][0];
		expect(called[0].metadata).toEqual({ external_id: 'ext-999' });
	});

	it('merges external_id into user-provided metadata', async () => {
		const supabase = makeSupabase();
		const body = payload({
			...ABSENCE,
			external_id: 'ext-42',
			metadata: { source: 'google-cal', colour: 'blue' },
		});
		const req = await signedRequest(body, SECRET);
		const res = await handleAbsenceWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(200);
		const called = (
			supabase.upsertUserAbsences as ReturnType<typeof vi.fn>
		).mock.calls[0][0];
		expect(called[0].metadata).toEqual({
			source: 'google-cal',
			colour: 'blue',
			external_id: 'ext-42',
		});
	});

	it('accepts all valid AbsenceKind values', async () => {
		const supabase = makeSupabase();
		for (const kind of ['vacation', 'sick', 'off', 'holiday']) {
			const body = payload({ ...ABSENCE, kind });
			const req = await signedRequest(body, SECRET);
			const res = await handleAbsenceWebhook(req, {
				supabase,
				secret: SECRET,
			});
			expect(res.status).toBe(200);
		}
		expect(supabase.upsertUserAbsences).toHaveBeenCalledTimes(4);
	});

	it('returns 502 when the DB upsert fails', async () => {
		const supabase = makeSupabase({
			upsertUserAbsences: vi
				.fn()
				.mockRejectedValue(new Error('connection refused')),
		});
		const body = payload(ABSENCE);
		const req = await signedRequest(body, SECRET);
		const res = await handleAbsenceWebhook(req, {
			supabase,
			secret: SECRET,
		});
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'db_error' });
	});
});

// --- HMAC unit tests ---

describe('verifyHmac', () => {
	it('accepts a correctly computed signature', async () => {
		const body = JSON.stringify({ absence_date: '2026-08-15' });
		const secret = 'my-secret-key';
		const sig = await sign(body, secret);
		const result = await verifyHmac(body, sig, secret);
		expect(result).toBe(true);
	});

	it('rejects a tampered body', async () => {
		const secret = 'my-secret-key';
		const sig = await sign(JSON.stringify({ kind: 'vacation' }), secret);
		const result = await verifyHmac(
			JSON.stringify({ kind: 'sick' }),
			sig,
			secret,
		);
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
