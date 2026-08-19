/**
 * Forward an authenticated request to the Tempo REST API.
 *
 * Tempo sends no CORS headers, so a browser can't read its responses
 * directly. This helper lets the hosted Premium endpoint relay the call.
 * The upstream base is FIXED to `https://api.tempo.io/4/`, so there is
 * no client-chosen host and therefore no SSRF surface.
 *
 * The Tempo API uses Bearer token auth. To keep the token out of request
 * URLs and logs, the browser sends it in the `X-Tempo-Token` header; we
 * place it in the upstream `Authorization: Bearer` header here and never
 * log it (mirrors the `X-Jira-Auth` / `X-RescueTime-Key` discipline).
 */

const TEMPO_BASE = 'https://api.tempo.io/4';

/** Statuses the Response constructor refuses to pair with a body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export interface ForwardOptions {
	path: string;
	search: string;
	tempoToken: string;
	method: string;
	body?: string;
}

/**
 * Reject paths that try to escape the /4/ namespace.
 *
 * We decode iteratively until the string stabilises so that double- (or
 * deeper-)encoded dot-segments are visible before the check.  A single decode
 * of `%252e%252e/admin` yields `%2e%2e/admin`, which still hides the `..`;
 * only after a second pass does it become `../admin`.  Without this loop,
 * fetch's WHATWG URL parser would perform that normalization transparently,
 * resolving the traversal OUTSIDE `/4/`.
 *
 * Malformed percent-sequences (e.g. a bare `%`) are treated as unsafe.
 *
 * The leading-slash check now guards decoded slashes too (e.g. `%2f` → `/`),
 * which were previously unreachable because the caller strips literal leading
 * slashes before calling us.
 */
function isSafePath(path: string): boolean {
	let decoded = path;
	try {
		let prev: string;
		do {
			prev = decoded;
			decoded = decodeURIComponent(decoded);
		} while (decoded !== prev);
	} catch {
		// Malformed percent-encoding → reject rather than throw.
		return false;
	}
	return (
		!decoded.includes('..') &&
		!decoded.startsWith('/') &&
		!decoded.includes('://')
	);
}

export async function forwardToTempo(opts: ForwardOptions): Promise<Response> {
	const cleanPath = opts.path.replace(/^\/+/, '');
	if (!isSafePath(cleanPath)) {
		return new Response(JSON.stringify({ error: 'bad_path' }), { status: 400 });
	}
	const url = `${TEMPO_BASE}/${cleanPath}${opts.search ? `?${opts.search}` : ''}`;
	const headers: Record<string, string> = {
		authorization: `Bearer ${opts.tempoToken}`,
		accept: 'application/json',
	};
	if (opts.body) headers['content-type'] = 'application/json';
	try {
		const upstream = await fetch(url, {
			method: opts.method,
			headers,
			body: opts.body,
		});
		const text = await upstream.text();
		// 204/205/304 must carry no body: the Response constructor rejects one
		// (in Node and the Edge runtime — though not in the jsdom test
		// environment, which is why the unit tests could not see this). The
		// throw landed in the catch below and became a 502, so Tempo's
		// successful DELETE — which answers 204 — was reported to the user as a
		// failure while the worklog had in fact been deleted.
		const body = NULL_BODY_STATUSES.has(upstream.status) ? null : text;
		return new Response(body, {
			status: upstream.status,
			headers: {
				'content-type':
					upstream.headers.get('content-type') ?? 'application/json',
			},
		});
	} catch {
		return new Response(JSON.stringify({ error: 'upstream_unreachable' }), {
			status: 502,
		});
	}
}
