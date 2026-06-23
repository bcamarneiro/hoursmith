/**
 * Forward an authenticated request to the RescueTime Analytic Data API.
 *
 * RescueTime sends no CORS headers, so a browser can't read its responses
 * directly. This helper lets the hosted Premium endpoint relay the call: the
 * upstream host is FIXED (`https://www.rescuetime.com/anapi/data`), so unlike
 * the Jira proxy there is no client-chosen host and therefore no SSRF surface.
 *
 * The RescueTime API only accepts its credential as the `key` query-string
 * parameter. To keep the key out of request URLs and logs, the browser sends it
 * in the `X-RescueTime-Key` header; we append it to the upstream query here and
 * never log it (mirrors the `X-Jira-Auth` discipline in jiraForward.ts).
 *
 * Linear: ADA-466 (key exposure), follow-up to ADA-271 (hosted proxy).
 */

import { corsHeaders } from './cors.js';

const RESCUETIME_DATA_URL = 'https://www.rescuetime.com/anapi/data';

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

export interface RescueTimeForwardInput {
	/** The incoming request from the browser (its query string is forwarded). */
	request: Request;
	/** RescueTime API key (from X-RescueTime-Key, already validated non-empty). */
	apiKey: string;
	/** Inject a fetch implementation in tests. Defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * Relay the browser's RescueTime request upstream and stream the response back
 * with our own CORS headers. The key is taken ONLY from `input.apiKey`; any
 * `key` the client smuggled into the query string is dropped first so it can't
 * override the authenticated value or leak through a different code path.
 */
export async function forwardToRescueTime(
	input: RescueTimeForwardInput,
): Promise<Response> {
	const origin = input.request.headers.get('origin');

	const incoming = new URL(input.request.url);
	const params = new URLSearchParams(incoming.search);
	// Drop our internal routing param (if a future rewrite adds one) and any
	// client-supplied key. The key comes exclusively from the header.
	params.delete('__target');
	params.delete('key');
	if (!params.has('format')) params.set('format', 'json');
	params.set('key', input.apiKey);

	const target = `${RESCUETIME_DATA_URL}?${params.toString()}`;
	const doFetch = input.fetchImpl ?? fetch;

	let upstream: Response;
	try {
		upstream = await doFetch(target, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				'user-agent': 'Hoursmith-Proxy/1.0',
			},
			redirect: 'manual',
		});
	} catch (err) {
		// Never echo the raw upstream error (it embeds the key-bearing URL).
		logForwardError(err);
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

/** Classify a `fetch` rejection as an abort/timeout (mirrors jiraForward.ts). */
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

/** Log an upstream forward failure server-side only — never the key or URL. */
function logForwardError(err: unknown): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-rescuetime-proxy',
			event: 'upstream_error',
			error: (err as Error)?.message ?? String(err),
		}),
	);
}

function jsonError(
	status: 502 | 504,
	body: { error: string },
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
