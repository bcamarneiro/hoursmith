/**
 * Absence webhook handler for Hoursmith Premium (ADA-645).
 *
 * External absence/calendar systems can POST absence events to keep
 * the `public.user_absences` table in sync. Each event represents one
 * absence day for one user and is authenticated via HMAC-SHA256 using
 * a shared secret (`ABSENCE_WEBHOOK_SECRET`).
 *
 * Body shape (single object or array of objects):
 *   user_id      — Supabase user id (the absent person)
 *   absence_date — YYYY-MM-DD
 *   kind         — 'vacation' | 'sick' | 'off' | 'holiday'
 *   reason       — human-readable label / event title
 *   provider_id? — links to absence_providers row (omit for ad-hoc)
 *   external_id? — id in the external system (stored in metadata)
 *   metadata?    — arbitrary provider-specific extras
 *
 * Signature: HMAC-SHA256 of the raw body bytes with the shared secret,
 * sent in the `X-Signature-256` header. Constant-time comparison.
 * Fail-closed: bad/missing signature → 401.
 *
 * Logging discipline:
 *   DO log:    user_id, count, kind, absence_date range, error codes.
 *   DO NOT log: raw body, secret, individual reason strings.
 */

import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
	type UserAbsenceUpsert,
} from '../_lib/supabaseAdmin.js';

// Edge runtime — pin to Frankfurt for GDPR residency.
export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

// --- Types ---

type Outcome =
	| 'ok'
	| 'invalid_signature'
	| 'invalid_payload'
	| 'server_misconfigured'
	| 'db_error';

export interface AbsenceWebhookDeps {
	/** Supabase admin client (injected in tests). */
	supabase?: SupabaseAdminClient;
	/** Shared secret for HMAC (defaults to env). */
	secret?: string;
	/** HMAC verifier: (rawBody, headerValue, secret) => boolean. */
	verify?: (
		rawBody: string,
		signature: string,
		secret: string,
	) => Promise<boolean>;
	/** Env source (tests). Defaults to `process.env`. */
	env?: Partial<Record<string, string | undefined>>;
}

// --- HMAC verification (WebCrypto, edge-compatible) ---

function utf8ToBytes(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

/**
 * Constant-time string comparison — avoids timing side-channels
 * leaking which byte position mismatched first.
 */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = '';
	for (const b of bytes) hex += b.toString(16).padStart(2, '0');
	return hex;
}

/**
 * Verify HMAC-SHA256(secret, rawBody) matches the hex digest in `X-Signature-256`.
 */
export async function verifyHmac(
	rawBody: string,
	signature: string,
	secret: string,
): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey(
			'raw',
			utf8ToBytes(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const sigBuf = await crypto.subtle.sign('HMAC', key, utf8ToBytes(rawBody));
		const expected = bytesToHex(new Uint8Array(sigBuf));
		return safeEqual(signature, expected);
	} catch {
		return false;
	}
}

// --- Request helpers ---

function extractSignature(headers: Headers): string | null {
	return headers.get('x-signature-256');
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

// --- Payload validation ---

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const VALID_KINDS = new Set(['vacation', 'sick', 'off', 'holiday']);

function validatePayload(body: unknown): UserAbsenceUpsert[] | null {
	const items: unknown[] = Array.isArray(body) ? body : [body];
	const records: UserAbsenceUpsert[] = [];

	for (const item of items) {
		if (!isRecord(item)) return null;

		const userId = item.user_id;
		const absenceDate = item.absence_date;
		const kind = item.kind;
		const reason = item.reason;

		if (
			typeof userId !== 'string' ||
			userId.length === 0 ||
			typeof absenceDate !== 'string' ||
			absenceDate.length === 0 ||
			// Quick sanity: YYYY-MM-DD
			!/^\d{4}-\d{2}-\d{2}$/.test(absenceDate) ||
			typeof kind !== 'string' ||
			!VALID_KINDS.has(kind) ||
			typeof reason !== 'string' ||
			reason.length === 0
		) {
			return null;
		}

		const providerId =
			typeof item.provider_id === 'string' && item.provider_id.length > 0
				? item.provider_id
				: null;

		const externalId =
			typeof item.external_id === 'string' && item.external_id.length > 0
				? item.external_id
				: undefined;

		const rawMeta: unknown = item.metadata;
		const meta: Record<string, unknown> =
			isRecord(rawMeta) ? rawMeta : {};

		if (externalId) {
			meta.external_id = externalId;
		}

		records.push({
			user_id: userId,
			provider_id: providerId,
			absence_date: absenceDate,
			kind,
			reason,
			metadata: Object.keys(meta).length > 0 ? meta : undefined,
		});
	}

	return records.length > 0 ? records : null;
}

// --- Handler ---

export default async function handler(request: Request): Promise<Response> {
	return handleAbsenceWebhook(request);
}

export async function handleAbsenceWebhook(
	request: Request,
	deps: AbsenceWebhookDeps = {},
): Promise<Response> {
	const start = Date.now();
	const env = deps.env ?? process.env;
	const secret = deps.secret ?? env.ABSENCE_WEBHOOK_SECRET;
	const verify = deps.verify ?? verifyHmac;

	// 1. POST only
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	// 2. Secret must be configured
	if (!secret) {
		logAbsence({
			userId: null,
			code: 'server_misconfigured',
			status: 500,
			durationMs: Date.now() - start,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	// 3. Read raw body (before HMAC verification)
	let rawBody: string;
	try {
		rawBody = await request.text();
	} catch {
		return jsonResponse(400, { error: 'invalid_payload' });
	}

	// 4. Verify HMAC signature
	const signature = extractSignature(request.headers);
	if (!signature || !(await verify(rawBody, signature, secret))) {
		logAbsence({
			userId: null,
			code: 'invalid_signature',
			status: 401,
			durationMs: Date.now() - start,
		});
		return jsonResponse(401, { error: 'invalid_signature' });
	}

	// 5. Parse and validate
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return jsonResponse(400, { error: 'invalid_payload' });
	}

	const records = validatePayload(parsed);
	if (!records) {
		logAbsence({
			userId: null,
			code: 'invalid_payload',
			status: 400,
			durationMs: Date.now() - start,
		});
		return jsonResponse(400, { error: 'invalid_payload' });
	}

	// 6. Persist via Supabase admin client
	let supabase: SupabaseAdminClient;
	try {
		supabase = deps.supabase ?? defaultSupabaseAdmin();
	} catch {
		logAbsence({
			userId: records[0].user_id,
			code: 'server_misconfigured',
			status: 500,
			durationMs: Date.now() - start,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	try {
		await supabase.upsertUserAbsences(records);
	} catch (err) {
		logAbsence({
			userId: records[0].user_id,
			code: 'db_error',
			status: 502,
			durationMs: Date.now() - start,
			detail: (err as Error).message,
		});
		return jsonResponse(502, { error: 'db_error' });
	}

	logAbsence({
		userId: records[0].user_id,
		code: 'ok',
		status: 200,
		count: records.length,
		durationMs: Date.now() - start,
	});
	return jsonResponse(200, { ok: true, synced: records.length });
}

// --- Structured logging ---

interface AbsenceLogFields {
	userId: string | null;
	code: Outcome;
	status: number;
	durationMs: number;
	count?: number;
	detail?: string;
}

function logAbsence(fields: AbsenceLogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-absence-webhook',
			user_id: fields.userId,
			code: fields.code,
			status: fields.status,
			duration_ms: fields.durationMs,
			...(fields.count !== undefined ? { count: fields.count } : {}),
			...(fields.detail ? { detail: fields.detail } : {}),
		}),
	);
}
