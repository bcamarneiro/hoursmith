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

export interface ForwardOptions {
	path: string;
	search: string;
	tempoToken: string;
	method: string;
	body?: string;
}

/** Reject paths that try to escape the /4/ namespace. */
function isSafePath(path: string): boolean {
	return !path.includes('..') && !path.startsWith('/') && !path.includes('://');
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
		return new Response(text, {
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
