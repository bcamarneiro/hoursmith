/**
 * Global request transformer — shared validation + type-casting for API handlers.
 *
 * Vercel Edge Functions don't have an Express-style middleware stack, so this
 * module provides a declarative schema-driven transformer that every handler
 * can use to parse, cast types, and validate incoming requests consistently.
 * Combined with the root `middleware.ts` (which catches malformed JSON early),
 * this gives full-stack request hygiene without duplicating parse/validate logic
 * across every route file.
 *
 * Design:
 *   - Pure functions (no side-effects) — testable without HTTP mocks.
 *   - Returns structured results (`ok: true | false`) so callers can branch.
 *   - Schema definition is type-safe via a `const` generic.
 *
 * Linear: ADA-754.
 */

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/** Primitives we can cast to. */
export type FieldType = 'string' | 'number' | 'boolean';

export interface FieldDef {
	type: FieldType;
	/** If true, the field must be present and non-null. */
	required?: boolean;
	/**
	 * When true, string values are coerced to the target type (e.g. "123" → 123,
	 * "true" → true). If coercion fails the value stays as-is and downstream
	 * validation should reject it.
	 */
	cast?: boolean;
}

export type BodySchema = Record<string, FieldDef>;
export type QuerySchema = Record<string, FieldDef>;

export interface RequestSchema {
	body?: BodySchema;
	query?: QuerySchema;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface TransformSuccess<TBody = Record<string, unknown>> {
	ok: true;
	/** Parsed + validated + cast body (null when no body was sent or no schema). */
	body: TBody | null;
	/** Parsed + cast query params (empty when no query schema). */
	query: Record<string, string | number | boolean>;
}

export interface TransformError {
	ok: false;
	status: number;
	error: string;
	/** Optional per-field validation details. */
	details?: TransformErrorDetail[];
}

export interface TransformErrorDetail {
	field: string;
	reason: string;
}

export type TransformResult<TBody = Record<string, unknown>> =
	| TransformSuccess<TBody>
	| TransformError;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse, validate, and cast an incoming Request's body + query params against a
 * declarative schema.
 *
 * ```ts
 * const result = await transformRequest(req, {
 *   body:   { email: { type: 'string', required: true } },
 *   query:  { limit: { type: 'number', cast: true } },
 * });
 * if (!result.ok) return jsonResponse(result.status, { error: result.error });
 * // result.body.email is string; result.query.limit is number
 * ```
 *
 * @param request  The web-platform Request object.
 * @param schema   Optional body + query schema. Omitting a section skips it.
 */
export async function transformRequest<const TSchema extends RequestSchema>(
	request: Request,
	schema?: TSchema,
): Promise<TransformResult> {
	const query: Record<string, string | number | boolean> = {};

	// --- Query params -------------------------------------------------------
	if (schema?.query) {
		const url = new URL(request.url);
		for (const [key, def] of Object.entries(schema.query) as [
			string,
			FieldDef,
		][]) {
			const raw = url.searchParams.get(key);
			if (raw !== null) {
				query[key] = castValue(raw, def);
			} else if (def.required) {
				return {
					ok: false,
					status: 400,
					error: 'missing_query_param',
					details: [{ field: key, reason: 'required' }],
				};
			}
		}
	}

	// --- Body ---------------------------------------------------------------
	if (!schema?.body) {
		return { ok: true, body: null, query };
	}

	// Only parse body for methods that conventionally carry a payload.
	const method = request.method.toUpperCase();
	if (!['POST', 'PUT', 'PATCH'].includes(method)) {
		return { ok: true, body: null, query };
	}

	// Check content-type.  Missing is ok (e.g. empty POST); if present it must
	// be JSON — rejecting form-encoded / multipart that we never use avoids
	// silent failures when a client sends the wrong type.
	const contentType = request.headers.get('content-type');
	if (contentType && !contentType.includes('application/json')) {
		return {
			ok: false,
			status: 415,
			error: 'unsupported_content_type',
		};
	}

	let rawBody: unknown;
	try {
		// Only consume the body if the content-type header signals JSON (or is
		// missing, which we treat as JSON for legacy clients).  An empty body
		// throws in some runtimes; we handle that as `null`.
		const text = await requestCloneSafeText(request);
		rawBody = text ? JSON.parse(text) : null;
	} catch {
		return { ok: false, status: 400, error: 'invalid_json' };
	}

	if (rawBody === null || rawBody === undefined) {
		// Check required fields — all of them fail if body is absent.
		const requiredErrors = requiredBodyErrors(schema.body);
		if (requiredErrors.length > 0) {
			return {
				ok: false,
				status: 400,
				error: 'validation_failed',
				details: requiredErrors,
			};
		}
		return { ok: true, body: null, query };
	}

	if (typeof rawBody !== 'object' || Array.isArray(rawBody)) {
		return { ok: false, status: 400, error: 'invalid_body_type' };
	}

	return validateAndCastBody(
		rawBody as Record<string, unknown>,
		schema.body,
		query,
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely read the request body as text.  We know some handlers (webhook) need
 * the raw `request.text()` and we don't want to consume the body here if they
 * bypass the transformer.  For handler-side usage the body is already owned by
 * the transformer once `transformRequest` is called.
 */
async function requestCloneSafeText(request: Request): Promise<string> {
	// In edge runtimes `request.text()` is cheap (the body is buffered in Vercel).
	// We don't clone because the caller has already committed to the transformer.
	return request.text();
}

function requiredBodyErrors(schema: BodySchema): TransformErrorDetail[] {
	const errors: TransformErrorDetail[] = [];
	for (const [key, def] of Object.entries(schema)) {
		if (def.required) {
			errors.push({ field: key, reason: 'required' });
		}
	}
	return errors;
}

function validateAndCastBody(
	body: Record<string, unknown>,
	schema: BodySchema,
	query: Record<string, string | number | boolean>,
): TransformResult {
	const cast: Record<string, unknown> = {};
	const errors: TransformErrorDetail[] = [];

	for (const [key, def] of Object.entries(schema) as [string, FieldDef][]) {
		const raw = body[key];

		if (raw === undefined || raw === null) {
			if (def.required) {
				errors.push({ field: key, reason: 'required' });
			}
			continue;
		}

		if (def.cast && typeof raw === 'string') {
			cast[key] = castValue(raw, def);
		} else if (!typeMatches(raw, def.type)) {
			errors.push({ field: key, reason: `expected_${def.type}` });
		} else {
			cast[key] = raw;
		}
	}

	if (errors.length > 0) {
		return {
			ok: false,
			status: 400,
			error: 'validation_failed',
			details: errors,
		};
	}

	return { ok: true, body: cast, query };
}

/** Coerce a string to the declared target type. */
export function castValue(
	val: string,
	def: FieldDef,
): string | number | boolean {
	if (!def.cast) return val;
	switch (def.type) {
		case 'number': {
			const n = Number(val);
			return Number.isNaN(n) ? val : n;
		}
		case 'boolean':
			return val === 'true' || val === '1';
		default:
			return val;
	}
}

/** Loose runtime type check. */
function typeMatches(val: unknown, type: FieldType): boolean {
	switch (type) {
		case 'string':
			return typeof val === 'string';
		case 'number':
			return typeof val === 'number';
		case 'boolean':
			return typeof val === 'boolean';
	}
}

// ---------------------------------------------------------------------------
// Convenience: standard JSON error response
// ---------------------------------------------------------------------------

export function jsonError(
	status: number,
	body: Record<string, unknown>,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
