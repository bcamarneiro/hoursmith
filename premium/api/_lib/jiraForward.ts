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
 * Reserved DNS suffixes that never point at a routable public host (RFC 6761,
 * mDNS, and common private conventions). Matched against the lowercased hostname.
 */
const BLOCKED_HOST_SUFFIXES = [
	'.localhost',
	'.local',
	'.internal',
	'.intranet',
	'.lan',
	'.corp',
	'.home',
	'.home.arpa',
];

/** True when `hostname` is a bare IPv4 literal (e.g. `10.0.0.5`, `8.8.8.8`). */
function isIpv4Literal(hostname: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	if (!m) return false;
	return m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * SSRF host policy (ADA-523, extends ADA-296). The proxy now serves self-hosted Jira, so
 * we can no longer rely on the old `*.atlassian.net` allowlist. Because the Edge runtime
 * cannot resolve DNS (no `node:dns`), we cannot inspect the *resolved* IP — so we
 * reject every host shape that could name an internal target and accept the rest:
 *
 *   - IP literals (v4 or v6, public or private) — legitimate Jira always uses a
 *     DNS hostname; a literal is the canonical SSRF vector (metadata endpoints,
 *     loopback, RFC-1918) and carries no verifiable host identity.
 *   - single-label hosts (`localhost`, `jira`) — never public.
 *   - reserved suffixes (`.local`, `.internal`, …) — never routable.
 *
 * Residual risk: a public hostname that *resolves* to a private IP (DNS
 * rebinding) still passes here. The Edge sandbox cannot reach RFC-1918/metadata
 * targets, which is the defense-in-depth backstop; full resolution-time pinning
 * would require moving this function to the Node runtime (tracked separately).
 */
function isUnsafeJiraHost(hostname: string): boolean {
	// IPv6 literals arrive bracketed from the URL parser (`[::1]`, `[fe80::1]`).
	if (hostname.startsWith('[')) return true;
	// Normalise FIRST — strip trailing dot(s) and lowercase — so a FQDN-root form
	// (`localhost.`, `127.0.0.1.`, `jira.internal.`) can't slip past the checks
	// below by carrying a dot the live hostname doesn't really add.
	const normalized = hostname.replace(/\.+$/, '').toLowerCase();
	if (isIpv4Literal(normalized)) return true;
	// No dot → single-label host (`localhost`, `jira`); never a public Jira.
	if (!normalized.includes('.')) return true;
	return BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
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
	// HTTPS only: the proxy forwards the user's Jira Basic credential upstream, so
	// a plaintext leg would expose it. Also closes off http-based SSRF probing.
	if (parsed.protocol !== 'https:') {
		return { ok: false, reason: 'X-Jira-Base must use https.' };
	}
	// SSRF guard (ADA-296). The URL parser lowercases the hostname and
	// resolves any `user@host` userinfo, so `…@10.0.0.1` is judged on its real host.
	if (isUnsafeJiraHost(parsed.hostname)) {
		return {
			ok: false,
			reason:
				'X-Jira-Base must be a public Jira host (no IP literals or internal names).',
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
	// Preserve query string from incoming request — minus our internal routing
	// param (ADA-381: the proxy path arrives via ?__target=… after the rewrite).
	url.searchParams.delete('__target');
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
		// Info-disclosure hardening (ADA-459): never echo the raw upstream error
		// (it can leak internal hostnames, IPs, or stack detail). Log it
		// server-side; return a generic code to the client.
		logForwardError(err, target.host);
		// Map an aborted/timed-out upstream to a 504 so the declared
		// `upstream_timeout` code is actually produced (ADA-459).
		if (isAbortOrTimeout(err)) {
			return jsonError(504, { error: 'upstream_timeout' }, origin);
		}
		return jsonError(502, { error: 'upstream_error' }, origin);
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

/**
 * Classify a `fetch` rejection as an abort/timeout (ADA-459). Covers the
 * standard `AbortError` (DOMException name) and undici's `TimeoutError` /
 * `UND_ERR_*` codes so an aborted or timed-out upstream maps to a 504.
 */
function isAbortOrTimeout(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false;
	const name = (err as { name?: unknown }).name;
	const code = (err as { code?: unknown }).code;
	const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
	return (
		name === 'AbortError' ||
		name === 'TimeoutError' ||
		code === 'ABORT_ERR' ||
		code === 'UND_ERR_CONNECT_TIMEOUT' ||
		code === 'UND_ERR_HEADERS_TIMEOUT' ||
		code === 'UND_ERR_BODY_TIMEOUT' ||
		causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
		causeCode === 'UND_ERR_HEADERS_TIMEOUT' ||
		causeCode === 'UND_ERR_BODY_TIMEOUT'
	);
}

/** Log an upstream forward failure server-side only (no client disclosure). */
function logForwardError(err: unknown, targetHost: string): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-jira-proxy',
			event: 'upstream_error',
			target_host: targetHost,
			error: (err as Error)?.message ?? String(err),
		}),
	);
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
