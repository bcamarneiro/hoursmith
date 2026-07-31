/**
 * Secure server-side logging for Hoursmith Premium (ADA-716).
 *
 * The Jira proxy decrypts third-party API tokens in memory and forwards
 * requests upstream. If a crypto or forwarding error message ever carries a
 * token (Jira API tokens are `jira_api:ATATT...`), an encrypted payload
 * (`aes256gcm:...` / `hsenc:v1:...`), or a request header, a naive `console.*`
 * call ships that secret straight into the log pipeline (Vercel / stdout).
 *
 * This module is the single choke point for premium-side logging:
 *   - `sanitizeForLog` deep-sanitizes arbitrary values — strings, errors,
 *     objects, arrays — replacing secret-shaped data with a fixed marker and
 *     keeping the rest intact for triage.
 *   - `secureLogger` is the logging interface wrapper: every argument is run
 *     through `sanitizeForLog` before it reaches `console.*`, so future
 *     callers can't accidentally log a secret.
 *
 * Fail-closed policy: anything we can't positively classify as safe to keep
 * (unknown shapes, non-enumerable objects, circular references) is replaced
 * with the marker rather than risk leaking text. Redacting a benign field is
 * acceptable; leaking a token is not.
 *
 * Dependency-free and edge-runtime compatible, mirroring `aesCrypto.ts` and
 * `tokenStorage.ts` in this folder.
 *
 * Linear: ADA-716.
 */

const REDACTED = '[redacted]';

// ---------------------------------------------------------------------------
// Secret-shaped string patterns
//
// Each pattern is applied independently so a log line can carry several
// secrets; the structural prefixes (`jira_api:`, `aes256gcm:`, `hsenc:v1:<kid>:`)
// are kept for triage, the secret material itself is replaced.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; keep?: string }> = [
	// Jira API token, e.g. `jira_api:ATATT3xFfGF0...` (tokenStorage format).
	{ re: /(jira_api:)[A-Za-z0-9_-]{6,}/g, keep: '$1' },
	// Raw Atlassian API token (no scheme prefix).
	{ re: /ATATT3xFfGF0[A-Za-z0-9_-]{6,}/g },
	// Standalone AES-256-GCM payload, e.g. `aes256gcm:<base64>`.
	{ re: /(aes256gcm:)[A-Za-z0-9+/=]{12,}/g, keep: '$1' },
	// Versioned encryption-service envelope: keep the key id for triage,
	// redact everything after it (inner ciphertext).
	{ re: /(hsenc:v1:[A-Za-z0-9_-]{1,32}:)[^\s"'`,;]+/g, keep: '$1' },
	// Authorization / Cookie header values: keep the key prefix for triage,
	// redact the rest of the line (covers multi-pair `Cookie: a=1; b=2`).
	// The `["'\s]*` bridge lets the pattern also match JSON-serialized
	// headers such as `"authorization":"Bearer ..."`.
	{ re: /(authorization["'\s]*[:=]["'\s]*)[^\n]*/gi, keep: '$1' },
	{ re: /(cookie["'\s]*[:=]["'\s]*)[^\n]*/gi, keep: '$1' },
	// Bare `Bearer` / `Basic` credentials anywhere in a string.
	{ re: /\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{6,}/gi, keep: '$1 ' },
];

/** Replace every secret-shaped fragment in `text` with the redaction marker. */
function maskString(text: string): string {
	let out = text;
	for (const { re, keep = '' } of SECRET_PATTERNS) {
		out = out.replace(re, keep + REDACTED);
	}
	return out;
}

/**
 * Object keys whose values are redacted wholesale, whatever their shape.
 * `auth` is matched as a whole key (benign fields like `auth_provider` stay
 * visible); the strong indicators match anywhere so `x-api-key`, `access_token`,
 * `cookie_string` etc. are all caught.
 */
const STRONG_SECRET_KEY =
	/(secret|password|passwd|pwd|token|api[_-]?key|authorization|cookie|credential)/i;
const AUTH_KEY = /^auth$/i;

function isSecretKey(key: string): boolean {
	return STRONG_SECRET_KEY.test(key) || AUTH_KEY.test(key);
}

// ---------------------------------------------------------------------------
// Deep sanitizer
// ---------------------------------------------------------------------------

/**
 * Deep-sanitize `value` for logging: redacts secret-shaped strings, redacts
 * values under secret-typed object keys, keeps `name`/`code` on errors, and
 * masks everything else that could carry text. Never throws.
 */
export function sanitizeForLog(value: unknown): unknown {
	try {
		return sanitizeValue(value, new WeakSet<object>());
	} catch {
		// Property getters / exotic shapes can throw — fail closed rather than
		// propagate (a crash in the sanitizer must not crash the request).
		return REDACTED;
	}
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
	if (value === null || value === undefined) return value;
	switch (typeof value) {
		case 'string':
			return maskString(value);
		case 'number':
		case 'boolean':
		case 'bigint':
			return value;
		case 'symbol':
			return REDACTED;
		case 'function':
			return '[Function]';
		case 'object':
			return sanitizeObject(value, seen);
	}
}

function sanitizeObject(value: object, seen: WeakSet<object>): unknown {
	if (seen.has(value)) return REDACTED; // circular reference — fail closed
	seen.add(value);

	if (value instanceof Error) return sanitizeError(value, seen);
	if (Array.isArray(value))
		return value.map((item) => sanitizeValue(item, seen));
	if (value instanceof Date) return maskString(value.toISOString());
	if (value instanceof URL) return maskString(value.toString());
	if (value instanceof RegExp) return maskString(value.source);
	if (value instanceof Map) {
		const out: Array<[unknown, unknown]> = [];
		for (const [key, item] of value.entries()) {
			out.push([sanitizeValue(key, seen), sanitizeValue(item, seen)]);
		}
		return out;
	}
	if (value instanceof Set) {
		return [...value].map((item) => sanitizeValue(item, seen));
	}

	if (typeof value !== 'object') return maskString(String(value));

	// Plain object (or object literal) — sanitize own enumerable entries.
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		// Unknown class instance — don't risk its toString/shape leaking text.
		return REDACTED;
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		out[key] = isSecretKey(key)
			? REDACTED
			: sanitizeValue(readProp(value, key), seen);
	}
	return out;
}

/** Property access that fails closed on throwing getters. */
function readProp(value: object, key: string): unknown {
	try {
		return (value as Record<string, unknown>)[key];
	} catch {
		return REDACTED;
	}
}

function sanitizeError(
	err: Error,
	seen: WeakSet<object>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { name: err.name };
	for (const key of Object.keys(err)) {
		if (key === 'name') continue; // exception type is safe to keep
		if (key === 'code') {
			out[key] = readProp(err, key); // status/error codes are benign triage data
			continue;
		}
		out[key] = isSecretKey(key)
			? REDACTED
			: sanitizeValue(readProp(err, key), seen);
	}
	// `message`, `stack`, and `cause` are non-enumerable on Error instances —
	// handle them explicitly, with the same string masking applied to each.
	if (err.message) out.message = maskString(err.message);
	if (err.stack) out.stack = maskString(err.stack);
	if (err.cause !== undefined) out.cause = sanitizeValue(err.cause, seen);
	return out;
}

// ---------------------------------------------------------------------------
// Logging interface wrapper
// ---------------------------------------------------------------------------

export interface SecureLogger {
	debug: (...args: unknown[]) => void;
	log: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

/**
 * Console wrapper that sanitizes every argument before emission. Drop-in
 * replacement for `console.*` in premium code paths.
 */
export const secureLogger: SecureLogger = {
	debug: (...args) => console.debug(...args.map(sanitizeForLog)),
	log: (...args) => console.log(...args.map(sanitizeForLog)),
	info: (...args) => console.info(...args.map(sanitizeForLog)),
	warn: (...args) => console.warn(...args.map(sanitizeForLog)),
	error: (...args) => console.error(...args.map(sanitizeForLog)),
};
