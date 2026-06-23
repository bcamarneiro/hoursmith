/**
 * Single seam for routing RescueTime requests through the appropriate gateway.
 *
 * RescueTime's Analytic Data API sends no CORS headers, so the browser can only
 * read it through *some* server. Three modes mirror the Jira gateway:
 *
 *   1. `hosted`      — Hoursmith Premium relay at `${origin}/api/rescuetime`.
 *                       Auth: `Authorization: Bearer <supabaseJwt>`; the
 *                       RescueTime key travels in `X-RescueTime-Key` and is
 *                       appended to the upstream `key=` server-side, so it never
 *                       appears in a URL the browser builds.
 *   2. `self-hosted` — user-configured cors-anywhere-style proxy:
 *                       `${userProxy}/https://www.rescuetime.com/anapi/data?…key=…`.
 *   3. `direct`      — no proxy and no entitlement. The request would hit
 *                       rescuetime.com directly and CORS-fail; callers use this
 *                       to fail fast with actionable copy instead.
 *
 * Unlike the Jira hosted proxy (which is Jira-only), this gateway has its own
 * dedicated endpoint, so a Premium user gets RescueTime with zero proxy config.
 *
 * Linear: ADA-466.
 */

import { getProxyOverrideState } from './proxyUrlBridge';

const RESCUETIME_DATA_URL = 'https://www.rescuetime.com/anapi/data';

export type RescueTimeGatewayMode = 'hosted' | 'self-hosted' | 'direct';

export interface RescueTimeRequestPieces {
	url: string;
	headers: Record<string, string>;
}

/** Compute the active gateway mode based on the bridge state + user proxy. */
export function getRescueTimeGatewayMode(
	userConfiguredProxy: string,
): RescueTimeGatewayMode {
	const { hostedProxyUrl, userOverride } = getProxyOverrideState();
	if (hostedProxyUrl && !userOverride) return 'hosted';
	return userConfiguredProxy.trim() ? 'self-hosted' : 'direct';
}

export interface BuildRescueTimeRequestOptions {
	/**
	 * Supabase access token override. When omitted, read from the bridge (which
	 * Premium auth keeps populated). The override exists for tests and callers
	 * that already hold a fresher token.
	 */
	supabaseAccessToken?: string | null;
}

/**
 * Build the URL + headers for a RescueTime `anapi/data` request.
 *
 * `params` MUST NOT contain `key` — the key is added here, either as a header
 * (hosted) or as a query param appended to the user's proxy URL (self-hosted).
 * In `direct` mode the key is still appended (the request will CORS-fail, but
 * callers are expected to check {@link getRescueTimeGatewayMode} first and avoid
 * issuing it).
 */
export function buildRescueTimeRequest(
	apiKey: string,
	userConfiguredProxy: string,
	params: URLSearchParams,
	options: BuildRescueTimeRequestOptions = {},
): RescueTimeRequestPieces {
	const bridge = getProxyOverrideState();
	const { hostedProxyUrl, userOverride } = bridge;

	if (hostedProxyUrl && !userOverride) {
		// Hosted: key in a header, never the URL. Params are forwarded verbatim.
		const endpoint = hostedRescueTimeEndpoint(hostedProxyUrl);
		const token = options.supabaseAccessToken ?? bridge.supabaseAccessToken;
		const headers: Record<string, string> = { 'x-rescuetime-key': apiKey };
		if (token) headers.authorization = `Bearer ${token}`;
		return { url: `${endpoint}?${params.toString()}`, headers };
	}

	// Self-hosted / direct: the key has to live in the query string (RescueTime
	// only accepts it there). Clone params so the caller's object stays clean.
	const withKey = new URLSearchParams(params);
	withKey.set('key', apiKey);
	const query = withKey.toString();
	const proxy = userConfiguredProxy.trim().replace(/\/$/, '');
	const url = proxy
		? `${proxy}/${RESCUETIME_DATA_URL}?${query}`
		: `${RESCUETIME_DATA_URL}?${query}`;
	return { url, headers: {} };
}

/**
 * Derive the sibling `/api/rescuetime` endpoint from the hosted proxy base
 * (`${origin}/api/proxy`). Both endpoints live under the same origin, so we
 * swap the well-known path suffix; if the shape is unexpected we append, which
 * still resolves to the right origin in practice.
 */
function hostedRescueTimeEndpoint(hostedProxyUrl: string): string {
	const trimmed = hostedProxyUrl.replace(/\/+$/, '');
	const suffix = '/api/proxy';
	if (trimmed.endsWith(suffix)) {
		return `${trimmed.slice(0, -suffix.length)}/api/rescuetime`;
	}
	return `${trimmed}/api/rescuetime`;
}
