/**
 * Hosted CORS proxy for Hoursmith Premium.
 *
 * Replaces the local `cors-proxy.js` (free tier) with a hosted Vercel Function
 * gated by Supabase auth + an active premium subscription. Jira credentials
 * still travel per-request via `X-Jira-Auth` and are never persisted server-side.
 *
 * Linear: ADA-271 (proxy), ADA-272 (entitlement gate).
 *
 * Request contract:
 *   - Authorization: Bearer <supabase_jwt>
 *   - X-Jira-Base:   https://<workspace>.atlassian.net
 *   - X-Jira-Auth:   Basic <base64(email:apitoken)>   (used verbatim upstream)
 *   - method/body/query forwarded to ${X-Jira-Base}/${path}
 *
 * Logging discipline (compliance-critical):
 *   DO log:    timestamp, user_id, upstream status, duration.
 *   DO NOT log: request/response body, X-Jira-Auth, X-Jira-Base value,
 *               Authorization header.
 */

import { corsHeaders } from '../_lib/cors.js';
import { getEntitlement } from '../_lib/entitlement.js';
import { forwardToJira } from '../_lib/jiraForward.js';
import { checkRateLimit } from '../_lib/rateLimit.js';

// Pin to Frankfurt for GDPR residency. Mirrors vercel.json.
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

	// 2. Validate Jira routing headers.
	const jiraBase = request.headers.get('x-jira-base');
	const jiraAuth = request.headers.get('x-jira-auth');
	if (!jiraBase || !jiraAuth) {
		logProxy({
			userId: entitlement.userId,
			upstreamStatus: 400,
			durationMs: Date.now() - start,
			note: 'missing_jira_headers',
		});
		return jsonResponse(
			400,
			{
				error: 'bad_request',
				detail: 'X-Jira-Base and X-Jira-Auth headers are required.',
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

	// 4. Extract catch-all path from the URL (everything after `/api/proxy/`).
	const path = extractPath(request.url);

	// 5. Forward.
	const upstream = await forwardToJira({
		request,
		path,
		jiraBase,
		jiraAuth,
	});

	logProxy({
		userId: entitlement.userId,
		upstreamStatus: upstream.status,
		durationMs: Date.now() - start,
	});

	return upstream;
}

/**
 * Extract the catch-all path. Vercel routes `premium/api/proxy/[...path].ts`
 * to e.g. `/api/proxy/rest/api/2/myself`; we want `rest/api/2/myself`.
 */
function extractPath(requestUrl: string): string {
	const { pathname } = new URL(requestUrl);
	const marker = '/api/proxy/';
	const idx = pathname.indexOf(marker);
	if (idx === -1) return '';
	return pathname.slice(idx + marker.length);
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
 * Structured log line. Explicitly scrubbed: no headers, no body, no Jira host.
 * TODO: replace with Sentry/Logflare once observability is wired (ADA tbd).
 */
function logProxy(fields: ProxyLogFields): void {
	const line = {
		ts: new Date().toISOString(),
		svc: 'hoursmith-proxy',
		user_id: fields.userId,
		upstream_status: fields.upstreamStatus,
		duration_ms: fields.durationMs,
		...(fields.note ? { note: fields.note } : {}),
	};
	console.log(JSON.stringify(line));
}
