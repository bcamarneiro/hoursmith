/**
 * Global request-transformer middleware for the Vercel Edge runtime.
 *
 * Runs BEFORE every API handler (matched via `config.matcher`). Its job is
 * pre-flight hygiene that every endpoint benefits from:
 *
 *   1. CORS preflight — respond to OPTIONS immediately (no cold-start penalty).
 *   2. Content-type validation — reject non-JSON POST/PUT/PATCH early (415).
 *
 * This middleware deliberately does NOT consume the request body or do deep
 * validation — those remain handler-local concerns because schema shapes
 * differ per endpoint (and because consuming the body here would starve
 * handlers in the Edge runtime).  For per-handler body/query validation,
 * import `transformRequest` from `premium/api/_lib/requestTransformer.ts`.
 *
 * Linear: ADA-756 (integration of ADA-754 + ADA-753 transformers).
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
	}

	// Pass through — handlers own body parsing via `transformRequest`.
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
