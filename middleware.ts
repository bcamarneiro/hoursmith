/**
 * Global request-transformer middleware for the Vercel Edge runtime.
 *
 * Runs BEFORE every API handler (matched via `config.matcher`). Its job is
 * pre-flight hygiene that every endpoint benefits from:
 *
 *   1. CORS preflight — respond to OPTIONS immediately (no cold-start penalty).
 *   2. Content-type validation — reject non-JSON POST/PUT/PATCH early (415).
 *   3. Malformed-JSON gate — parse + discard after checking syntax, returning
 *      400 if the body is broken, so handlers never see a half-consumed stream
 *      or a cryptic parse error mid-logic.
 *
 * This middleware deliberately does NOT do deep field validation, type-casting,
 * or auth — those remain handler-local concerns because schema shapes differ
 * per endpoint.  For per-handler body/query validation, import
 * `transformRequest` from `api/_lib/requestTransformer.ts`.
 *
 * Linear: ADA-754.
 */

/** HTTP methods that conventionally carry a JSON payload. */
const PAYLOAD_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export default async function middleware(
	request: Request,
): Promise<Response | undefined> {
	// ── CORS preflight ──────────────────────────────────────────────────────
	if (request.method === 'OPTIONS') {
		return corsPreflightResponse(request);
	}

	// ── Content-type gate ───────────────────────────────────────────────────
	if (PAYLOAD_METHODS.has(request.method)) {
		const ct = request.headers.get('content-type');
		if (ct && !ct.includes('application/json')) {
			return jsonResponse(415, {
				error: 'unsupported_content_type',
				detail: 'This endpoint accepts application/json only.',
			});
		}

		// ── Malformed-JSON gate ─────────────────────────────────────────────
		// Consume + validate the body now so that handlers get a clean stream.
		// We discard the parsed value — this is a syntax gate only.
		if (ct || request.headers.get('content-length') !== '0') {
			try {
				const text = await request.text();
				if (text.length > 0) {
					JSON.parse(text);
				}
			} catch {
				return jsonResponse(400, { error: 'invalid_json' });
			}
		}
	}

	// Pass through — the handler receives the original request.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set of origins allowed for CORS.  Mirrors `api/_lib/cors.ts`. */
const ALLOWED_ORIGINS = new Set([
	'https://hoursmith.io',
	'https://www.hoursmith.io',
	'https://staging.hoursmith.io',
	'http://localhost:5173',
	'http://localhost:5174',
	'http://127.0.0.1:5173',
	'http://127.0.0.1:5174',
]);

function corsPreflightResponse(request: Request): Response {
	const origin = request.headers.get('origin');
	const acao = origin && (ALLOWED_ORIGINS.has(origin) ? origin : '');

	const headers: Record<string, string> = {
		'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
		'access-control-allow-headers':
			'authorization, content-type, x-jira-base, x-jira-auth',
		'access-control-max-age': '86400',
	};
	if (acao) headers['access-control-allow-origin'] = acao;

	return new Response(null, { status: 204, headers });
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * Matcher: only run on API routes.  The SPA itself (HTML/CSS/JS) is never
 * intercepted.  Uses Vercel's matcher syntax — simple enough to be safe.
 */
export const config = {
	matcher: '/api/:path*',
};
