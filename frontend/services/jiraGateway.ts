/**
 * Single seam for routing Jira requests through the appropriate gateway.
 *
 * Three modes exist today:
 *
 *   1. `direct`      — browser talks straight to `https://<jiraHost>/<path>`.
 *                       Auth: see `jiraAuth.ts` — Basic on Cloud, Bearer on
 *                       Server/DC. Cloud 403s on Bearer with an API token.
 *   2. `self-hosted` — user-configured cors-anywhere-style proxy:
 *                       `${userProxy}/https://<jiraHost>/<path>`.
 *                       Auth: same as direct.
 *   3. `hosted`      — Hoursmith Premium proxy at `${origin}/api/proxy/<path>`.
 *                       Auth: `Authorization: Bearer <supabaseJwt>`. Jira
 *                       credentials travel in `X-Jira-Auth: Basic <b64>`, and
 *                       the routing target is in `X-Jira-Base`. The Edge
 *                       function forwards verbatim; nothing is persisted.
 *
 * Existing call sites have been written for modes 1 and 2 — they construct
 * URLs of the form `${baseUrl}/<path>` where `baseUrl` is `${proxy}/https://<jiraHost>`
 * (proxy) or `https://<jiraHost>` (direct). To keep the diff small, this
 * module exposes `rewriteForHostedProxy(url, headers, opts)` that:
 *
 *   - in modes 1+2: returns its inputs unchanged (no-op);
 *   - in mode 3:    rewrites the URL onto `/api/proxy` and swaps the auth
 *                   headers per the contract above.
 *
 * Call sites stay the same shape; only the request just before `fetch()` is
 * piped through this seam.
 *
 * Linear: ADA-273.
 */

import { getProxyOverrideState, resolveProxyUrl } from './proxyUrlBridge';

export type JiraGatewayMode = 'direct' | 'self-hosted' | 'hosted';

export interface JiraRequestPieces {
	url: string;
	headers: Record<string, string>;
}

export interface RewriteOptions {
	/** Bare Jira host. Needed to populate `X-Jira-Base` in hosted mode. */
	jiraHost: string;
	/** User's Jira email — left half of the Basic credential in hosted mode. */
	email: string;
	/** Jira API token — right half of the Basic credential in hosted mode. */
	apiToken: string;
	/**
	 * Supabase access token override. When omitted, the helper reads it from
	 * the bridge (which Premium auth keeps populated). The override exists for
	 * tests and call sites that already hold a fresher token.
	 */
	supabaseAccessToken?: string | null;
}

/** Compute the active gateway mode based on the bridge state. */
export function getJiraGatewayMode(
	userConfiguredProxy: string,
): JiraGatewayMode {
	const { hostedProxyUrl, userOverride } = getProxyOverrideState();
	if (hostedProxyUrl && !userOverride) return 'hosted';
	const effective = resolveProxyUrl(userConfiguredProxy);
	return effective ? 'self-hosted' : 'direct';
}

/**
 * Rewrite a Jira fetch's URL+headers for the hosted Premium proxy. No-op in
 * direct/self-hosted modes — call sites stay shape-stable.
 *
 * `originalUrl` is whatever the call site has already built (typically
 * `${base}/rest/api/2/...`). In hosted mode we discard the base and rebuild
 * onto `/api/proxy`, but we still want to forward the path verbatim.
 */
export function rewriteForHostedProxy(
	originalUrl: string,
	originalHeaders: Record<string, string>,
	opts: RewriteOptions,
): JiraRequestPieces {
	const bridge = getProxyOverrideState();
	const { hostedProxyUrl, userOverride } = bridge;
	if (!hostedProxyUrl || userOverride) {
		return { url: originalUrl, headers: originalHeaders };
	}

	const supabaseAccessToken =
		opts.supabaseAccessToken ?? bridge.supabaseAccessToken;
	const path = extractJiraPath(originalUrl, opts.jiraHost);
	const base = hostedProxyUrl.replace(/\/+$/, '');
	const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

	// Strip any `Authorization` from the original — that slot now holds the
	// Supabase JWT, and the Jira credential moves to `X-Jira-Auth`.
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(originalHeaders)) {
		if (key.toLowerCase() === 'authorization') continue;
		headers[key] = value;
	}
	if (supabaseAccessToken) {
		headers.authorization = `Bearer ${supabaseAccessToken}`;
	}
	headers['x-jira-base'] = `https://${opts.jiraHost}`;
	headers['x-jira-auth'] =
		`Basic ${encodeBasicAuth(opts.email, opts.apiToken)}`;

	return { url, headers };
}

/**
 * Pull the Jira API path out of a URL the caller has already built. Handles
 * both the direct shape (`https://host/rest/...`) and the self-hosted-proxy
 * shape (`https://proxy.example/https://host/rest/...`).
 */
function extractJiraPath(url: string, jiraHost: string): string {
	const marker = `https://${jiraHost}`;
	const idx = url.indexOf(marker);
	if (idx === -1) return '';
	return url.slice(idx + marker.length) || '/';
}

function encodeBasicAuth(email: string, token: string): string {
	const raw = `${email}:${token}`;
	if (typeof btoa === 'function') return btoa(raw);
	return Buffer.from(raw, 'utf8').toString('base64');
}
