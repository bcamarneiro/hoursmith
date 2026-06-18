/**
 * Canonical error format for HTTP-backed services.
 *
 * Today each service throws its own ad-hoc string ("Jira search error: 401",
 * "Jira API error: 401", "Calendar feed error: 503"). UI error mappers
 * have to special-case all of them. This helper produces a stable shape
 * so callers can `instanceof ServiceError` and read `.code` / `.status`
 * directly.
 *
 * Existing throw sites are migrated incrementally — old string-only errors
 * still work because `ServiceError` extends `Error` with the same
 * `message` field, and `parseServiceError(unknown)` extracts the status
 * from legacy strings as a fallback.
 */
export type ServiceErrorKind =
	| 'unauthorized'
	| 'forbidden'
	| 'not-found'
	| 'rate-limited'
	| 'server-error'
	| 'network'
	| 'invalid-token'
	| 'unknown';

/**
 * Entitlement codes the hosted Premium proxy returns in the JSON body of a
 * 401/403 (`{ error: <code> }`, see `api/proxy/index.ts` →
 * `premium/api/_lib/entitlement.ts`). These mean the *Hoursmith* session/sub
 * is the problem — NOT the user's Jira credentials. Capturing the code lets the
 * mapper steer the user to re-auth instead of telling them to fix a Jira token
 * that is perfectly valid (ADA-475).
 */
export type EntitlementCode =
	| 'missing_token'
	| 'invalid_token'
	| 'subscription_required'
	| 'server_misconfigured';

const ENTITLEMENT_CODES: readonly EntitlementCode[] = [
	'missing_token',
	'invalid_token',
	'subscription_required',
	'server_misconfigured',
];

export class ServiceError extends Error {
	readonly kind: ServiceErrorKind;
	readonly status?: number;
	readonly source: string;
	/**
	 * Entitlement code parsed from a hosted-proxy 401/403 body, when present.
	 * Distinguishes "your Hoursmith session expired" from "your Jira token is
	 * bad" — both are 401s, but only the latter is about Jira credentials.
	 */
	readonly entitlementCode?: EntitlementCode;

	constructor(opts: {
		kind: ServiceErrorKind;
		status?: number;
		source: string;
		message: string;
		entitlementCode?: EntitlementCode;
	}) {
		super(opts.message);
		this.name = 'ServiceError';
		this.kind = opts.kind;
		this.status = opts.status;
		this.source = opts.source;
		this.entitlementCode = opts.entitlementCode;
	}
}

/** Narrow an arbitrary parsed body `error` value to a known entitlement code. */
export function asEntitlementCode(value: unknown): EntitlementCode | undefined {
	return typeof value === 'string' &&
		(ENTITLEMENT_CODES as readonly string[]).includes(value)
		? (value as EntitlementCode)
		: undefined;
}

export function classifyHttpStatus(status: number): ServiceErrorKind {
	if (status === 401) return 'unauthorized';
	if (status === 403) return 'forbidden';
	if (status === 404) return 'not-found';
	if (status === 429) return 'rate-limited';
	if (status >= 500) return 'server-error';
	return 'unknown';
}

export function fromHttpResponse(
	source: string,
	status: number,
	context = '',
	entitlementCode?: EntitlementCode,
): ServiceError {
	const kind = classifyHttpStatus(status);
	const tail = context ? ` — ${context}` : '';
	return new ServiceError({
		kind,
		status,
		source,
		message: `${source} ${kind} (HTTP ${status})${tail}`,
		entitlementCode,
	});
}

/**
 * Build a `ServiceError` from a non-ok `Response`, reading the body for a
 * hosted-proxy entitlement code on 401/403. The body is consumed defensively —
 * a non-JSON / empty body simply yields no code (and a genuine Jira 401 has no
 * entitlement code, so it stays a "fix your Jira token" error). ADA-475.
 */
export async function fromHttpResponseAsync(
	source: string,
	res: {
		status: number;
		clone?: () => { json: () => Promise<unknown> };
		json?: () => Promise<unknown>;
	},
	context = '',
): Promise<ServiceError> {
	let entitlementCode: EntitlementCode | undefined;
	if (res.status === 401 || res.status === 403) {
		try {
			// Clone so the caller can still read the body if it wants to.
			const reader = res.clone ? res.clone() : res;
			const body = (await reader.json?.()) as { error?: unknown } | undefined;
			entitlementCode = asEntitlementCode(body?.error);
		} catch {
			// Non-JSON / already-consumed body → no entitlement code. Falls through
			// to a plain Jira-credentials error, which is the safe default.
		}
	}
	return fromHttpResponse(source, res.status, context, entitlementCode);
}

export function fromRichMessage(
	source: string,
	status: number | undefined,
	message: string,
): ServiceError {
	const kind = status ? classifyHttpStatus(status) : 'unknown';
	return new ServiceError({ kind, status, source, message });
}

export function fromNetworkError(source: string, error: unknown): ServiceError {
	const inner = error instanceof Error ? error.message : String(error);
	return new ServiceError({
		kind: 'network',
		source,
		message: `${source} network error: ${inner}`,
	});
}

/**
 * User-facing remediation copy. `message` is what to show; `action`, when
 * present, points the UI at a recovery affordance (re-auth or Settings).
 */
export interface ServiceErrorCopy {
	message: string;
	/** Suggested recovery route, if a specific one applies. */
	action?: { kind: 'sign-in' | 'settings'; label: string; to: string };
}

/**
 * True when the error is a browser CORS / "Failed to fetch" network failure —
 * the classic direct-mode block. Substring-matches the well-known message
 * because the browser surfaces it as a bare `TypeError`.
 */
function looksLikeCorsFailure(message: string): boolean {
	const m = message.toLowerCase();
	return (
		m.includes('failed to fetch') ||
		m.includes('networkerror') ||
		m.includes('load failed') ||
		m.includes('cors')
	);
}

/**
 * The single error→user-copy mapper (ADA-475). Consumers should call this
 * instead of flattening to `error.message` or substring-matching `'401'`.
 *
 * Keyed on, in priority order:
 *   1. the entitlement `code` carried in a hosted-proxy 401/403 body — these
 *      mean the *Hoursmith* session/subscription is the problem, so we steer to
 *      sign-in / billing, NOT to "check your Jira token";
 *   2. the `ServiceError.kind` / `status`;
 *   3. a CORS / "Failed to fetch" network signature → "browser blocked direct
 *      access — try the CORS proxy";
 *   4. legacy string errors (best-effort substring fallback).
 */
export function describeServiceError(error: unknown): ServiceErrorCopy {
	const signIn = {
		kind: 'sign-in' as const,
		label: 'Sign in again',
		to: '/auth/sign-in',
	};
	const settings = {
		kind: 'settings' as const,
		label: 'Check Settings',
		to: '/settings',
	};

	if (error instanceof ServiceError) {
		// 1. Entitlement codes first — a hosted-proxy 401/403 about the Hoursmith
		// session, not the Jira credential.
		switch (error.entitlementCode) {
			case 'invalid_token':
			case 'missing_token':
				return {
					message:
						'Your Hoursmith session expired — sign in again to keep syncing.',
					action: signIn,
				};
			case 'subscription_required':
				return {
					message:
						'Your Hoursmith subscription is no longer active. Renew it to use the hosted proxy.',
					action: signIn,
				};
			case 'server_misconfigured':
				return {
					message:
						'The Hoursmith proxy is temporarily unavailable. Please try again shortly.',
				};
		}

		// 2. Kind/status — genuine integration errors.
		switch (error.kind) {
			case 'unauthorized':
				return {
					message:
						'Jira rejected your credentials (401). Check your Jira email and API token in Settings.',
					action: settings,
				};
			case 'forbidden':
				return {
					message:
						"Jira accepted the request but denied access (403). Check your account's project permissions.",
					action: settings,
				};
			case 'not-found':
				return {
					message:
						"Couldn't reach the Jira host (404). Confirm the host name in Settings.",
					action: settings,
				};
			case 'rate-limited':
				return {
					message:
						'Jira is rate-limiting or temporarily unavailable. This is usually transient — please retry.',
				};
			case 'server-error':
				return {
					message:
						'Jira returned a server error. This is usually temporary — please retry.',
				};
			case 'network':
				if (looksLikeCorsFailure(error.message)) {
					return {
						message:
							'Your browser blocked direct access to Jira (CORS). Try configuring the CORS proxy in Settings.',
						action: settings,
					};
				}
				return {
					message:
						'Network error reaching Jira. Check your connection and retry.',
				};
		}

		return { message: error.message };
	}

	// 4. Legacy / non-ServiceError fallbacks.
	const message = error instanceof Error ? error.message : String(error);
	if (looksLikeCorsFailure(message)) {
		return {
			message:
				'Your browser blocked direct access to Jira (CORS). Try configuring the CORS proxy in Settings.',
			action: settings,
		};
	}
	if (message.includes('401')) {
		return {
			message:
				'Jira rejected your credentials (401). Check your Jira email and API token in Settings.',
			action: settings,
		};
	}
	if (message.includes('403')) {
		return {
			message:
				'Jira accepted the request but denied access (403). Check your project permissions in Settings.',
			action: settings,
		};
	}
	if (message.includes('404')) {
		return {
			message:
				"Couldn't reach the Jira host (404). Confirm the host name in Settings.",
			action: settings,
		};
	}
	return { message: message || 'Something went wrong. Please try again.' };
}
