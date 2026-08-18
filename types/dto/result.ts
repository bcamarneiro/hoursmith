/**
 * Standard validation result shape used throughout Hoursmith.
 *
 * Mirrors the `{ ok: true, value } | { ok: false, reason }` pattern already
 * established in API endpoints (waitlist, checkout, proxy). Formalising it as a
 * generic type lets every layer — from edge handlers to service modules — return
 * a single, predictable error shape without try/catch after every parse.
 *
 * Prefer this over throwing for validation failures; reserve thrown errors for
 * truly exceptional paths (network failure, misconfigured env).
 */

/** A successful parse/validation with the typed output. */
export interface Ok<T> {
	ok: true;
	value: T;
}

/** A failed parse/validation with a machine-readable reason code. */
export interface Err {
	ok: false;
	reason: string;
}

export type ValidationResult<T> = Ok<T> | Err;

/** Shorthand for building an Ok result. */
export function ok<T>(value: T): Ok<T> {
	return { ok: true, value };
}

/** Shorthand for building an Err result. */
export function err(reason: string): Err {
	return { ok: false, reason };
}

/**
 * Parse a raw JSON string into an unknown value, catching syntax errors.
 * Returns `Err<'bad_json'>` instead of throwing so callers don't need a
 * try/catch around every `JSON.parse` call site.
 */
export function parseJson(input: string): ValidationResult<unknown> {
	try {
		return ok(JSON.parse(input));
	} catch {
		return err('bad_json');
	}
}
