/**
 * Premium waitlist endpoint.
 *
 * Public (no JWT) email capture for the pre-launch Hoursmith Premium waitlist.
 * Called by the Pricing page (ADA-267) and the in-app Settings card (ADA-268).
 *
 * Linear: ADA-269.
 *
 * Behavior when Supabase is unset:
 *   The Supabase project is provisioned in a separate workstream (ADA-254).
 *   Until it lands, this function returns 200 with `{ saved: false, reason:
 *   'collection_not_yet_active' }` so the Pricing page can ship today without
 *   blocking on backend bringup. The frontend treats this as success — the
 *   user still sees the "Thanks." confirmation; we just don't store anything.
 *
 * Logging discipline (GDPR):
 *   DO log:    timestamp, source, outcome.
 *   DO NOT log: the email value, IP address, or any other request body field.
 */

import { corsHeaders } from '../_lib/cors.js';

// Pin to Frankfurt for GDPR residency. Mirrors vercel.json.
export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

const VALID_SOURCES = ['pricing', 'in-app-settings'] as const;
type WaitlistSource = (typeof VALID_SOURCES)[number];

// RFC 5322 is famously hostile to regex. Keep this intentionally simple — the
// server is not authoritative for deliverability; this just rejects obvious
// junk so we don't fill the table with garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface WaitlistAdminClient {
	upsertEmail(input: {
		email: string;
		source: WaitlistSource;
	}): Promise<{ ok: true } | { ok: false; reason: 'table_missing' | 'error' }>;
}

export interface WaitlistHandlerOptions {
	/** Inject a client (tests). Defaults to env-driven fetch client (or null). */
	client?: WaitlistAdminClient | null;
}

export default async function handler(request: Request): Promise<Response> {
	return waitlistHandler(request);
}

/**
 * Exported for tests. Mirrors the pattern in `_lib/entitlement.ts`: real env
 * client by default, mock client injectable.
 */
export async function waitlistHandler(
	request: Request,
	options: WaitlistHandlerOptions = {},
): Promise<Response> {
	const origin = request.headers.get('origin');
	const json = (status: number, body: Record<string, unknown>): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
		});

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders(origin) });
	}
	if (request.method !== 'POST') {
		return json(405, { error: 'method_not_allowed' });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		logEvent({ source: null, outcome: 'bad_json' });
		return json(400, { error: 'invalid_body' });
	}

	const parsed = parseBody(body);
	if (!parsed.ok) {
		logEvent({ source: null, outcome: parsed.reason });
		return json(400, { error: parsed.reason });
	}

	const { email, source } = parsed.value;

	// Resolve the admin client. `null` = Supabase not configured yet → no-op.
	const client =
		options.client === undefined ? defaultAdminClient() : options.client;

	if (client === null) {
		logEvent({ source, outcome: 'no_supabase' });
		return json(200, { saved: false, reason: 'collection_not_yet_active' });
	}

	const result = await client.upsertEmail({ email, source });
	if (!result.ok) {
		logEvent({ source, outcome: `db_${result.reason}` });
		// Don't break UX over backend wiring; treat as silent no-op for the user.
		return json(200, { saved: false });
	}

	logEvent({ source, outcome: 'saved' });
	return json(200, { saved: true });
}

type ParsedBody =
	| { ok: true; value: { email: string; source: WaitlistSource } }
	| { ok: false; reason: 'missing_email' | 'invalid_email' | 'invalid_source' };

function parseBody(body: unknown): ParsedBody {
	if (!body || typeof body !== 'object')
		return { ok: false, reason: 'missing_email' };
	const obj = body as Record<string, unknown>;
	const rawEmail = obj.email;
	if (typeof rawEmail !== 'string' || rawEmail.trim().length === 0) {
		return { ok: false, reason: 'missing_email' };
	}
	const email = rawEmail.trim().toLowerCase();
	if (email.length > 254 || !EMAIL_RE.test(email)) {
		return { ok: false, reason: 'invalid_email' };
	}
	const rawSource = obj.source;
	if (
		typeof rawSource !== 'string' ||
		!VALID_SOURCES.includes(rawSource as WaitlistSource)
	) {
		return { ok: false, reason: 'invalid_source' };
	}
	return { ok: true, value: { email, source: rawSource as WaitlistSource } };
}

/**
 * Env-driven admin client. Returns `null` if Supabase isn't configured yet
 * (the collection_not_yet_active path). When ADA-254 lands and env vars are
 * set, this returns a real PostgREST client.
 */
function defaultAdminClient(): WaitlistAdminClient | null {
	const url = process.env.SUPABASE_URL;
	const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !serviceRoleKey) return null;
	return new FetchWaitlistAdminClient(url, serviceRoleKey);
}

/**
 * Minimal PostgREST writer. Service-role key bypasses RLS.
 * Uses `Prefer: resolution=ignore-duplicates` for idempotent upsert by PK.
 */
class FetchWaitlistAdminClient implements WaitlistAdminClient {
	constructor(
		private readonly url: string,
		private readonly serviceRoleKey: string,
	) {}

	async upsertEmail(input: {
		email: string;
		source: WaitlistSource;
	}): Promise<{ ok: true } | { ok: false; reason: 'table_missing' | 'error' }> {
		try {
			const res = await fetch(`${this.url}/rest/v1/waitlist`, {
				method: 'POST',
				headers: {
					apikey: this.serviceRoleKey,
					authorization: `Bearer ${this.serviceRoleKey}`,
					'content-type': 'application/json',
					prefer: 'resolution=ignore-duplicates,return=minimal',
				},
				body: JSON.stringify([{ email: input.email, source: input.source }]),
			});
			if (res.ok) return { ok: true };
			// PostgREST returns 404 when the table is missing.
			if (res.status === 404) return { ok: false, reason: 'table_missing' };
			return { ok: false, reason: 'error' };
		} catch {
			return { ok: false, reason: 'error' };
		}
	}
}

interface WaitlistLogFields {
	source: WaitlistSource | null;
	outcome: string;
}

/**
 * Structured log line. Never includes the email value — GDPR scoping.
 */
function logEvent(fields: WaitlistLogFields): void {
	const line = {
		ts: new Date().toISOString(),
		svc: 'hoursmith-waitlist',
		source: fields.source,
		outcome: fields.outcome,
	};
	console.log(JSON.stringify(line));
}
