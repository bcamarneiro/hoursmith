/**
 * Hosted Tempo relay for Hoursmith Premium.
 *
 * Tempo's REST API sends no CORS headers, so the browser can't read it
 * directly. This Edge Function relays the call for entitled users —
 * gated by the same Supabase auth + active subscription as the Jira proxy.
 * The Tempo token travels per-request in `X-Tempo-Token` and is never
 * persisted or logged.
 *
 * Request contract:
 *   - Authorization:  Bearer <supabase_jwt>
 *   - X-Tempo-Token:  <tempo_api_token>   (forwarded as upstream Authorization)
 *   - query string:   path=<tempo-path>&<forwarded-params>
 *
 * Only GET is supported in Plan 1. POST/PUT/DELETE will be added in Plan 2.
 *
 * Logging discipline (compliance-critical):
 *   DO log:    timestamp, user_id, upstream status, duration.
 *   DO NOT log: the token, the upstream URL, the response body,
 *               the Authorization header.
 */

import { corsHeaders } from '../_lib/cors.js';
import { getEntitlement } from '../_lib/entitlement.js';
import { checkRateLimit } from '../_lib/rateLimit.js';
import { forwardToTempo } from '../_lib/tempoForward.js';

// Pin to Frankfurt for GDPR residency. Mirrors vercel.json and the Jira proxy.
export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export default async function handler(request: Request): Promise<Response> {
	const start = Date.now();
	const origin = request.headers.get('origin');

	// Preflight: respond without auth so the browser can probe.
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders(origin) });
	}

	// Plan 1: read methods only.
	if (request.method !== 'GET') {
		logProxy({
			userId: null,
			upstreamStatus: 405,
			durationMs: Date.now() - start,
			note: 'method_not_allowed',
		});
		return jsonResponse(
			405,
			{ error: 'method_not_allowed', detail: 'Only GET is supported.' },
			origin,
			{ allow: 'GET, OPTIONS' },
		);
	}

	// 1. Entitlement check (Supabase JWT + active subscription).
	const entitlement = await getEntitlement(request);
	if (!entitlement.ok) {
		logProxy({
			userId: null,
			upstreamStatus: entitlement.status,
			durationMs: Date.now() - start,
			note: entitlement.code,
		});
		return jsonResponse(
			entitlement.status,
			{ error: entitlement.code },
			origin,
		);
	}

	// 2. Validate the Tempo token header.
	const tempoToken = request.headers.get('x-tempo-token');
	if (!tempoToken) {
		logProxy({
			userId: entitlement.userId,
			upstreamStatus: 400,
			durationMs: Date.now() - start,
			note: 'missing_tempo_token',
		});
		return jsonResponse(
			400,
			{
				error: 'bad_request',
				detail: 'X-Tempo-Token header is required.',
			},
			origin,
		);
	}

	// 3. Extract path and remaining query params.
	const incoming = new URL(request.url);
	const params = new URLSearchParams(incoming.search);
	const path = params.get('path') ?? '';
	params.delete('path');
	if (!path) {
		logProxy({
			userId: entitlement.userId,
			upstreamStatus: 400,
			durationMs: Date.now() - start,
			note: 'missing_path',
		});
		return jsonResponse(
			400,
			{ error: 'bad_request', detail: '`path` query parameter is required.' },
			origin,
		);
	}

	// 4. Per-user rate limit. Fails open if the counter store is unavailable,
	//    so a transient backend issue never blocks a paying user.
	const rate = await checkRateLimit(entitlement.userId);
	if (!rate.allowed) {
		logProxy({
			userId: entitlement.userId,
			upstreamStatus: 429,
			durationMs: Date.now() - start,
			note: 'rate_limited',
		});
		return jsonResponse(
			429,
			{
				error: 'rate_limited',
				detail: 'Too many requests. Please retry shortly.',
				retry_after: rate.retryAfterSeconds,
			},
			origin,
			{ 'retry-after': String(rate.retryAfterSeconds) },
		);
	}

	// 5. Forward to the Tempo API.
	const upstream = await forwardToTempo({
		path,
		search: params.toString(),
		tempoToken,
		method: 'GET',
	});

	logProxy({
		userId: entitlement.userId,
		upstreamStatus: upstream.status,
		durationMs: Date.now() - start,
	});

	return upstream;
}

function jsonResponse(
	status: number,
	body: Record<string, unknown>,
	origin: string | null,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			...corsHeaders(origin),
			...extraHeaders,
		},
	});
}

interface ProxyLogFields {
	userId: string | null;
	upstreamStatus: number;
	durationMs: number;
	note?: string;
}

/**
 * Structured log line. Explicitly scrubbed: no token, no URL, no body.
 */
function logProxy(fields: ProxyLogFields): void {
	const line = {
		ts: new Date().toISOString(),
		svc: 'hoursmith-tempo-proxy',
		user_id: fields.userId,
		upstream_status: fields.upstreamStatus,
		duration_ms: fields.durationMs,
		...(fields.note ? { note: fields.note } : {}),
	};
	console.log(JSON.stringify(line));
}
