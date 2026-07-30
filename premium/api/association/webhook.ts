/**
 * Association webhook handler for Hoursmith Premium (ADA-640).
 *
 * External services / automation can POST association records linking
 * external entities (calendar events, git commits, RescueTime activities)
 * to Jira issues. Each request is authenticated via HMAC-SHA256 using a
 * shared secret (`ASSOCIATION_WEBHOOK_SECRET`).
 *
 * The body is an object (or array of objects) with:
 *   user_id         — Supabase user id (the owner)
 *   external_source — namespace, e.g. "calendar", "gitlab", "rescuetime"
 *   external_id     — id in the external system
 *   issue_key       — Jira issue key, e.g. "ADA-123"
 *   issue_summary?  — optional human-readable issue summary
 *   title_pattern?  — optional glob/regex for matching event titles
 *   event_time?     — ISO timestamp of the original event
 *
 * Signature scheme: HMAC-SHA256 of the raw body bytes with the shared secret,
 * sent in the `X-Signature-256` header. The verifier recomputes and
 * constant-time-compares.
 *
 * Fail-closed: a bad or missing signature → 401, never process.
 *
 * Logging discipline:
 *   DO log:    timestamp, user_id, external_source, issue_key count, error code.
 *   DO NOT log: the raw body, secret, or full association payload.
 */

import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';

// Edge runtime — pin to Frankfurt for GDPR residency (mirrors checkout).
export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

// --- Types ---

export interface AssociationRecord {
	user_id: string;
	external_source: string;
	external_id: string;
	issue_key: string;
	issue_summary?: string;
	title_pattern?: string;
	event_time?: string;
}

export interface AssociationWebhookDeps {
	/** Supabase admin client (injected in tests). */
	supabase?: SupabaseAdminClient;
	/** Shared secret used to verify the HMAC (defaults to env). */
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
	const enc = new TextEncoder();
	return enc.encode(s);
}

/** Constant-time string comparison to avoid timing side-channels. */
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
 * Verify an HMAC-SHA256 signature. The sender computes
 * `HMAC-SHA256(secret, rawBody)` and sends the hex digest as the
 * `X-Signature-256` header. We recompute and compare constant-time.
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
		const sigBuffer = await crypto.subtle.sign(
			'HMAC',
			key,
			utf8ToBytes(rawBody),
		);
		const expected = bytesToHex(new Uint8Array(sigBuffer));
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

function validatePayload(body: unknown): AssociationRecord[] | null {
	const items: unknown[] = Array.isArray(body) ? body : [body];

	const records: AssociationRecord[] = [];
	for (const item of items) {
		if (!isRecord(item)) return null;
		const userId = item.user_id;
		const externalSource = item.external_source;
		const externalId = item.external_id;
		const issueKey = item.issue_key;
		if (
			typeof userId !== 'string' ||
			userId.length === 0 ||
			typeof externalSource !== 'string' ||
			externalSource.length === 0 ||
			typeof externalId !== 'string' ||
			externalId.length === 0 ||
			typeof issueKey !== 'string' ||
			issueKey.length === 0
		) {
			return null;
		}
		records.push({
			user_id: userId,
			external_source: externalSource,
			external_id: externalId,
			issue_key: issueKey,
			issue_summary:
				typeof item.issue_summary === 'string' &&
				item.issue_summary.length > 0
					? item.issue_summary
					: undefined,
			title_pattern:
				typeof item.title_pattern === 'string' &&
				item.title_pattern.length > 0
					? item.title_pattern
					: undefined,
			event_time:
				typeof item.event_time === 'string' && item.event_time.length > 0
					? item.event_time
					: undefined,
		});
	}
	return records.length > 0 ? records : null;
}

// --- Handler ---

export default async function handler(request: Request): Promise<Response> {
	return handleAssociationWebhook(request);
}

export async function handleAssociationWebhook(
	request: Request,
	deps: AssociationWebhookDeps = {},
): Promise<Response> {
	const start = Date.now();
	const env = deps.env ?? process.env;
	const secret = deps.secret ?? env.ASSOCIATION_WEBHOOK_SECRET;
	const verify = deps.verify ?? verifyHmac;

	// 1. POST only
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	// 2. Secret must be configured
	if (!secret) {
		logAssociation({
			userId: null,
			source: null,
			code: 'server_misconfigured',
			status: 500,
			durationMs: Date.now() - start,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	// 3. Read the raw body (for HMAC verification and parsing).
	let rawBody: string;
	try {
		rawBody = await request.text();
	} catch {
		return jsonResponse(400, { error: 'invalid_payload' });
	}

	// 4. Verify HMAC signature
	const signature = extractSignature(request.headers);
	if (!signature || !(await verify(rawBody, signature, secret))) {
		logAssociation({
			userId: null,
			source: null,
			code: 'invalid_signature',
			status: 401,
			durationMs: Date.now() - start,
		});
		return jsonResponse(401, { error: 'invalid_signature' });
	}

	// 5. Parse & validate the payload
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return jsonResponse(400, { error: 'invalid_payload' });
	}

	const records = validatePayload(parsed);
	if (!records) {
		logAssociation({
			userId: null,
			source: null,
			code: 'invalid_payload',
			status: 400,
			durationMs: Date.now() - start,
		});
		return jsonResponse(400, { error: 'invalid_payload' });
	}

	// 6. Resolve Supabase admin client and persist
	let supabase: SupabaseAdminClient;
	try {
		supabase = deps.supabase ?? defaultSupabaseAdmin();
	} catch {
		logAssociation({
			userId: records[0].user_id,
			source: records[0].external_source,
			code: 'server_misconfigured',
			status: 500,
			durationMs: Date.now() - start,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	try {
		await supabase.upsertAssociations(
			records as unknown as Record<string, unknown>[],
		);
	} catch (err) {
		logAssociation({
			userId: records[0].user_id,
			source: records[0].external_source,
			code: 'db_error',
			status: 502,
			durationMs: Date.now() - start,
			detail: (err as Error).message,
		});
		return jsonResponse(502, { error: 'db_error' });
	}

	logAssociation({
		userId: records[0].user_id,
		source: records[0].external_source,
		code: 'ok',
		status: 200,
		count: records.length,
		durationMs: Date.now() - start,
	});
	return jsonResponse(200, {
		ok: true,
		associated: records.length,
	});
}

// --- Structured logging ---

interface AssociationLogFields {
	userId: string | null;
	source: string | null;
	code: string;
	status: number;
	durationMs: number;
	count?: number;
	detail?: string;
}

function logAssociation(fields: AssociationLogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-association-webhook',
			user_id: fields.userId,
			source: fields.source,
			code: fields.code,
			status: fields.status,
			duration_ms: fields.durationMs,
			...(fields.count !== undefined ? { count: fields.count } : {}),
			...(fields.detail ? { detail: fields.detail } : {}),
		}),
	);
}
