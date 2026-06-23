/**
 * Hosted RescueTime relay for Hoursmith Premium.
 *
 * RescueTime's Analytic Data API sends no CORS headers, so the browser can't
 * read it directly. This Edge Function relays the call for entitled users —
 * gated by the same Supabase auth + active subscription as the Jira proxy.
 * The RescueTime key travels per-request in `X-RescueTime-Key` and is never
 * persisted or logged.
 *
 * Request contract:
 *   - Authorization:    Bearer <supabase_jwt>
 *   - X-RescueTime-Key: <rescuetime_api_key>   (appended to the upstream `key=`)
 *   - query string:     perspective, restrict_kind, resolution_time,
 *                       restrict_begin, restrict_end, format — forwarded verbatim
 *
 * Logging discipline (compliance-critical):
 *   DO log:    timestamp, user_id, upstream status, duration.
 *   DO NOT log: the API key, the upstream URL, the response body,
 *               the Authorization header.
 *
 * Linear: ADA-466 (key exposure), follow-up to ADA-271 (hosted proxy).
 */

import { corsHeaders } from '../_lib/cors.js';
import { getEntitlement } from '../_lib/entitlement.js';
import { checkRateLimit } from '../_lib/rateLimit.js';
import { forwardToRescueTime } from '../_lib/rescueTimeForward.js';

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

	// 2. Validate the RescueTime key header.
	const apiKey = request.headers.get('x-rescuetime-key');
	if (!apiKey) {
		logProxy({
			userId: entitlement.userId,
			upstreamStatus: 400,
			durationMs: Date.now() - start,
			note: 'missing_rescuetime_key',
		});
		return jsonResponse(
			400,
			{
				error: 'bad_request',
				detail: 'X-RescueTime-Key header is required.',
			},
			origin,
		);
	}

	// 3. Per-user rate limit (ADA-302). Fails open if the counter store is
	//    unavailable, so a transient backend issue never blocks a paying user.
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

	// 4. Forward to the fixed RescueTime endpoint.
	const upstream = await forwardToRescueTime({ request, apiKey });

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
 * Structured log line. Explicitly scrubbed: no key, no URL, no body.
 */
function logProxy(fields: ProxyLogFields): void {
	const line = {
		ts: new Date().toISOString(),
		svc: 'hoursmith-rescuetime-proxy',
		user_id: fields.userId,
		upstream_status: fields.upstreamStatus,
		duration_ms: fields.durationMs,
		...(fields.note ? { note: fields.note } : {}),
	};
	console.log(JSON.stringify(line));
}
