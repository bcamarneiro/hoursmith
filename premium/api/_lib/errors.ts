/**
 * Standard error DTOs and unified error class hierarchy for the Hoursmith API.
 *
 * Every API endpoint that returns a JSON error body MUST conform to
 * {@link ApiErrorResponse} so callers (frontend, proxy, integration tests) can
 * depend on a stable `{ error, detail? }` shape with a well-known set of codes.
 *
 * {@link ApiError} is the canonical error class — endpoints can throw it or
 * call `.toResponse()` for a ready-to-send `Response`. The static factory
 * methods mirror the HTTP error categories so call sites read naturally:
 *
 *   return ApiError.unauthorized('missing_token').toResponse();
 *   return ApiError.notFound('no_billing_history').toResponse();
 *
 * The {@link jsonError} helper wraps {@link ApiError.toResponse} with CORS
 * headers for cross-origin endpoints.
 */

import { corsHeaders } from './cors.js';

// ── Error codes ─────────────────────────────────────────────────────────────

/**
 * Canonical set of error codes returned in {@link ApiErrorResponse.error}.
 * Extracted from the existing ad-hoc `{ error: "..." }` bodies across every
 * endpoint so downstream consumers can exhaustively switch on them.
 */
export type ApiErrorCode =
	// 400 — Bad Request
	| 'bad_request'
	| 'invalid_body'
	| 'invalid_tier'
	| 'invalid_email'
	| 'missing_email'
	| 'invalid_source'
	// 401 — Unauthorized
	| 'missing_token'
	| 'invalid_token'
	// 403 — Forbidden
	| 'subscription_required'
	| 'paywall_closed'
	// 404 — Not Found
	| 'not_found'
	| 'no_billing_history'
	// 405 — Method Not Allowed
	| 'method_not_allowed'
	// 429 — Too Many Requests
	| 'rate_limited'
	// 500 — Internal Server Error
	| 'server_misconfigured'
	| 'delete_failed'
	| 'subscription_read_failed'
	// 502 — Bad Gateway
	| 'polar_session_failed'
	| 'polar_portal_failed'
	// 503 — Service Unavailable
	| 'checkout_disabled';

// ── Response DTO ────────────────────────────────────────────────────────────

/**
 * Shape of every JSON error response the Hoursmith API returns.
 *
 *   - `error`     — machine-readable code from {@link ApiErrorCode}.
 *   - `detail`    — optional human-readable explanation (safe for UI display).
 *   - `retryAfterSeconds` — optional, only present on 429 responses.
 */
export interface ApiErrorResponse {
	error: ApiErrorCode;
	detail?: string;
	retryAfterSeconds?: number;
}

// ── Error class ─────────────────────────────────────────────────────────────

/**
 * Structured API error with an HTTP status, a typed error code, and an
 * optional human-readable detail.
 *
 * Static factories ({@link badRequest}, {@link unauthorized}, etc.) are the
 * preferred construction path — they enforce the mapping between code kind and
 * HTTP status and keep call sites one-liners.
 */
export class ApiError extends Error {
	readonly status: number;
	readonly code: ApiErrorCode;
	readonly detail?: string;
	readonly retryAfterSeconds?: number;

	constructor(opts: {
		status: number;
		code: ApiErrorCode;
		message: string;
		detail?: string;
		retryAfterSeconds?: number;
	}) {
		super(opts.message);
		this.name = 'ApiError';
		this.status = opts.status;
		this.code = opts.code;
		this.detail = opts.detail;
		this.retryAfterSeconds = opts.retryAfterSeconds;
	}

	/** The JSON body this error serialises to. */
	toJSON(): ApiErrorResponse {
		const body: ApiErrorResponse = { error: this.code };
		if (this.detail) body.detail = this.detail;
		if (this.retryAfterSeconds !== undefined) {
			body.retryAfterSeconds = this.retryAfterSeconds;
		}
		return body;
	}

	/**
	 * Build an HTTP {@link Response} from this error.
	 */
	toResponse(): Response {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
		};
		if (this.retryAfterSeconds !== undefined) {
			headers['retry-after'] = String(this.retryAfterSeconds);
		}
		// CORS headers are applied dynamically so this module stays dependency-free.
		// The `corsHeaders` helper lives in api/_lib/cors.ts; callers that need
		// CORS should pass `origin` and merge.
		return new Response(JSON.stringify(this.toJSON()), {
			status: this.status,
			headers,
		});
	}

	// ── 400 factories ───────────────────────────────────────────────────

	static badRequest(
		code: ApiErrorCode & (
			| 'bad_request'
			| 'invalid_body'
			| 'invalid_tier'
			| 'invalid_email'
			| 'missing_email'
			| 'invalid_source'
		),
		detail?: string,
	): ApiError {
		return new ApiError({
			status: 400,
			code,
			message: detail ?? code,
			detail,
		});
	}

	// ── 401 factories ───────────────────────────────────────────────────

	static unauthorized(
		code: ApiErrorCode & ('missing_token' | 'invalid_token'),
		detail?: string,
	): ApiError {
		return new ApiError({
			status: 401,
			code,
			message: detail ?? code,
			detail,
		});
	}

	// ── 403 factories ───────────────────────────────────────────────────

	static forbidden(
		code: ApiErrorCode & ('subscription_required' | 'paywall_closed'),
		detail?: string,
	): ApiError {
		return new ApiError({
			status: 403,
			code,
			message: detail ?? code,
			detail,
		});
	}

	// ── 404 factories ───────────────────────────────────────────────────

	static notFound(
		code: ApiErrorCode & ('not_found' | 'no_billing_history'),
		detail?: string,
	): ApiError {
		return new ApiError({
			status: 404,
			code,
			message: detail ?? code,
			detail,
		});
	}

	// ── 405 factories ───────────────────────────────────────────────────

	static methodNotAllowed(): ApiError {
		return new ApiError({
			status: 405,
			code: 'method_not_allowed',
			message: 'method_not_allowed',
		});
	}

	// ── 429 factories ───────────────────────────────────────────────────

	static rateLimited(retryAfterSeconds: number, detail?: string): ApiError {
		return new ApiError({
			status: 429,
			code: 'rate_limited',
			message: detail ?? 'rate_limited',
			detail,
			retryAfterSeconds,
		});
	}

	// ── 500 factories ───────────────────────────────────────────────────

	static serverError(
		code: ApiErrorCode & (
			| 'server_misconfigured'
			| 'delete_failed'
			| 'subscription_read_failed'
		),
		detail?: string,
	): ApiError {
		return new ApiError({
			status: 500,
			code,
			message: detail ?? code,
			detail,
		});
	}

	// ── 502 factories ───────────────────────────────────────────────────

	static badGateway(
		code: ApiErrorCode & ('polar_session_failed' | 'polar_portal_failed'),
		detail?: string,
	): ApiError {
		return new ApiError({
			status: 502,
			code,
			message: detail ?? code,
			detail,
		});
	}

	// ── 503 factories ───────────────────────────────────────────────────

	static serviceUnavailable(
		code: ApiErrorCode & 'checkout_disabled',
		detail?: string,
	): ApiError {
		return new ApiError({
			status: 503,
			code,
			message: detail ?? code,
			detail,
		});
	}
}

// ── Utility ─────────────────────────────────────────────────────────────────

/**
 * Build a JSON error {@link Response} from an {@link ApiError} with CORS
 * headers reflected from the request origin.
 *
 * Usage:
 *   const err = ApiError.unauthorized('missing_token');
 *   return jsonError(err, request.headers.get('origin'));
 *
 * @param origin — the request's `Origin` header (pass `null` for same-origin).
 */
export function jsonError(
	error: ApiError,
	origin?: string | null,
): Response {
	const res = error.toResponse();
	const headers = new Headers(res.headers);
	const ch = corsHeaders(origin ?? null);
	for (const [k, v] of Object.entries(ch)) {
		headers.set(k, v);
	}
	return new Response(res.body, {
		status: res.status,
		headers,
	});
}
