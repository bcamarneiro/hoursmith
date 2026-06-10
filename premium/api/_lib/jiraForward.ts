/**
 * Forward an authenticated request to a Jira instance.
 *
 * The frontend sends Jira credentials per-request via two headers so we never
 * persist them server-side:
 *   - X-Jira-Base: https://<workspace>.atlassian.net
 *   - X-Jira-Auth: Basic <base64(email:apitoken)>  (or Bearer for self-hosted)
 *
 * This helper validates those headers, performs the upstream request, and
 * returns a `Response` with the upstream body streamed back and CORS headers
 * applied. CORS-related response headers from upstream are stripped so the
 * browser sees exactly one (ours).
 *
 * Linear: ADA-271.
 */

import { corsHeaders } from './cors.js';

/** Headers we drop before forwarding to Jira (browser-injected, leaky, or ours). */
const REQUEST_HEADER_BLOCKLIST = new Set([
	'host',
	'connection',
	'content-length',
	'cookie',
	'cookie2',
	'origin',
	'referer',
	'authorization', // replaced with X-Jira-Auth below
	'x-jira-auth',
	'x-jira-base',
	'sec-fetch-dest',
	'sec-fetch-mode',
	'sec-fetch-site',
	'sec-ch-ua',
	'sec-ch-ua-mobile',
	'sec-ch-ua-platform',
]);

/** Headers we strip from upstream before responding (CORS + hop-by-hop). */
const RESPONSE_HEADER_BLOCKLIST = new Set([
	'access-control-allow-origin',
	'access-control-allow-credentials',
	'access-control-allow-methods',
	'access-control-allow-headers',
	'access-control-expose-headers',
	'access-control-max-age',
	'connection',
	'keep-alive',
	'transfer-encoding',
	'content-encoding', // upstream is already decoded by fetch
	'content-length', // recomputed by the runtime
]);

export interface JiraForwardInput {
	/** The incoming request from the browser. */
	request: Request;
	/** Catch-all path captured by the Vercel route (e.g. `rest/api/2/myself`). */
	path: string;
	/** Trusted X-Jira-Base header value (already validated). */
	jiraBase: string;
	/** Trusted X-Jira-Auth header value (used verbatim as upstream Authorization). */
	jiraAuth: string;
}

export interface JiraForwardError {
	ok: false;
	status: 400 | 502 | 504;
	code: 'bad_jira_base' | 'upstream_error' | 'upstream_timeout';
	message: string;
}

/**
 * Validate the X-Jira-Base header and return a usable URL or an error object.
 * Exported for unit testing.
 */
export function validateJiraBase(
	jiraBase: string | null | undefined,
): { ok: true; url: URL } | { ok: false; reason: string } {
	if (!jiraBase) {
		return { ok: false, reason: 'X-Jira-Base header is required.' };
	}
	let parsed: URL;
	try {
		parsed = new URL(jiraBase);
	} catch {
		return { ok: false, reason: 'X-Jira-Base is not a valid URL.' };
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		return { ok: false, reason: 'X-Jira-Base must be http(s).' };
	}
	// SSRF guard (ADA-296): only forward to Jira Cloud sites. An allowlist of the
	// `.atlassian.net` suffix inherently rejects loopback, link-local, RFC-1918,
	// the 169.254.x metadata endpoint, and look-alike hosts — none of which end
	// in `.atlassian.net`. The URL parser lowercases the hostname and resolves
	// any `user@host` userinfo, so `…@evil.com` is judged on its real host.
	// Self-hosted Jira (a future per-user allowed-host hook) is out of scope.
	if (!parsed.hostname.endsWith('.atlassian.net')) {
		return {
			ok: false,
			reason: 'X-Jira-Base must be a Jira Cloud site (*.atlassian.net).',
		};
	}
	return { ok: true, url: parsed };
}

/** Permissive CORS headers. TODO(ADA-271): lock down to https://hoursmith.io. */

/**
 * Build the outbound request to Jira and stream the response back.
 */
export async function forwardToJira(
	input: JiraForwardInput,
): Promise<Response> {
	const origin = input.request.headers.get('origin');
	const baseCheck = validateJiraBase(input.jiraBase);
	if (!baseCheck.ok) {
		return jsonError(
			400,
			{
				error: 'bad_request',
				detail: baseCheck.reason,
			},
			origin,
		);
	}

	// Build target URL: base + path + original query string.
	const url = new URL(input.request.url);
	const target = new URL(baseCheck.url.toString());
	// Trim leading slash on path so URL composition is deterministic.
	const cleanPath = input.path.replace(/^\/+/, '');
	target.pathname =
		target.pathname.replace(/\/+$/, '') + (cleanPath ? `/${cleanPath}` : '');
	// Preserve query string from incoming request.
	target.search = url.search;

	const outboundHeaders = buildOutboundHeaders(
		input.request.headers,
		input.jiraAuth,
		target.host,
	);

	// Body forwarding: GET/HEAD have no body; otherwise stream the body through.
	const method = input.request.method.toUpperCase();
	const hasBody = method !== 'GET' && method !== 'HEAD';

	let upstream: Response;
	try {
		upstream = await fetch(target.toString(), {
			method,
			headers: outboundHeaders,
			body: hasBody ? input.request.body : undefined,
			redirect: 'manual',
			// `duplex: 'half'` is required by undici when streaming a request body.
			// Cast to keep TS happy across Node runtimes that don't yet type it.
			...(hasBody ? ({ duplex: 'half' } as Record<string, unknown>) : {}),
		});
	} catch (err) {
		return jsonError(
			502,
			{
				error: 'upstream_error',
				detail: (err as Error).message,
			},
			origin,
		);
	}

	// Strip CORS + hop-by-hop headers from upstream; add our own CORS.
	const responseHeaders = new Headers();
	upstream.headers.forEach((value, key) => {
		if (!RESPONSE_HEADER_BLOCKLIST.has(key.toLowerCase())) {
			responseHeaders.set(key, value);
		}
	});
	for (const [k, v] of Object.entries(corsHeaders(origin))) {
		responseHeaders.set(k, v);
	}

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: responseHeaders,
	});
}

function buildOutboundHeaders(
	incoming: Headers,
	jiraAuth: string,
	targetHost: string,
): Headers {
	const out = new Headers();
	incoming.forEach((value, key) => {
		if (!REQUEST_HEADER_BLOCKLIST.has(key.toLowerCase())) {
			out.set(key, value);
		}
	});
	out.set('authorization', jiraAuth);
	out.set('host', targetHost);
	out.set('user-agent', 'Hoursmith-Proxy/1.0');
	// Atlassian's CSRF prevention header — harmless for endpoints that don't need it.
	out.set('x-atlassian-token', 'no-check');
	return out;
}

function jsonError(
	status: 400 | 502 | 504,
	body: { error: string; detail?: string },
	origin: string | null,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			...corsHeaders(origin),
		},
	});
}
