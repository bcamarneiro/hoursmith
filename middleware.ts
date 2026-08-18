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
 * CORS policy is delegated to `premium/api/_lib/cors.ts` so there is a single
 * source of truth across middleware and handler responses.  The 415 error
 * response includes CORS headers so preflight-aware clients see a proper error.
 *
 * Linear: ADA-756 (integration of ADA-754 + ADA-753 transformers).
 */

import { corsHeaders } from './premium/api/_lib/cors.js';

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
			return jsonResponse(
				415,
				{
					error: 'unsupported_content_type',
					detail: 'This endpoint accepts application/json only.',
				},
				request.headers.get('origin'),
			);
		}
	}

	// Pass through — handlers own body parsing via `transformRequest`.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsPreflightResponse(request: Request): Response {
	const origin = request.headers.get('origin');
	return new Response(null, {
		status: 204,
		headers: corsHeaders(origin),
	});
}

function jsonResponse(
	status: number,
	body: Record<string, unknown>,
	origin: string | null = null,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			...corsHeaders(origin),
		},
	});
}

/**
 * Matcher: only run on API routes.  The SPA itself (HTML/CSS/JS) is never
 * intercepted.  Uses Vercel's matcher syntax — simple enough to be safe.
 */
export const config = {
	matcher: '/api/:path*',
};
