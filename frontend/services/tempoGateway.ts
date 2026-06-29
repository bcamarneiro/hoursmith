/**
 * Single seam for routing Tempo Cloud API requests through the right gateway.
 *
 * `api.tempo.io` sends no browser CORS headers, so the browser can only reach it
 * through *some* server. Three modes mirror the RescueTime gateway:
 *   1. `hosted`      — Premium relay at `${origin}/api/tempo`. The Tempo token
 *                      travels in `X-Tempo-Token` and becomes the upstream
 *                      `Authorization: Bearer` server-side, never in a browser URL.
 *   2. `self-hosted` — user CORS proxy: `${proxy}/https://api.tempo.io/4/<path>`.
 *   3. `direct`      — would CORS-fail; callers check the mode first and fail fast.
 */
import { getProxyOverrideState } from './proxyUrlBridge';

const TEMPO_BASE = 'https://api.tempo.io/4';

export type TempoGatewayMode = 'hosted' | 'self-hosted' | 'direct';

export function getTempoGatewayMode(
	userConfiguredProxy: string,
): TempoGatewayMode {
	const { hostedProxyUrl, userOverride } = getProxyOverrideState();
	if (hostedProxyUrl && !userOverride) return 'hosted';
	return userConfiguredProxy.trim() ? 'self-hosted' : 'direct';
}

export interface TempoRequestPieces {
	url: string;
	headers: Record<string, string>;
}

export function buildTempoRequest(
	tempoToken: string,
	userConfiguredProxy: string,
	path: string,
	params: URLSearchParams = new URLSearchParams(),
	options: { supabaseAccessToken?: string | null } = {},
): TempoRequestPieces {
	const bridge = getProxyOverrideState();
	const { hostedProxyUrl, userOverride } = bridge;
	const cleanPath = path.replace(/^\/+/, '');

	if (hostedProxyUrl && !userOverride) {
		// Hosted: token in a header. The relay reads `path` from the query and
		// rebuilds the upstream URL, so we pass `path` as a query param.
		const endpoint = hostedTempoEndpoint(hostedProxyUrl);
		const merged = new URLSearchParams({ path: cleanPath });
		for (const [k, v] of params) merged.append(k, v);
		const token = options.supabaseAccessToken ?? bridge.supabaseAccessToken;
		const headers: Record<string, string> = { 'x-tempo-token': tempoToken };
		if (token) headers.authorization = `Bearer ${token}`;
		const qs = merged.toString();
		return { url: qs ? `${endpoint}?${qs}` : endpoint, headers };
	}

	const qs = params.toString();
	const upstream = `${TEMPO_BASE}/${cleanPath}${qs ? `?${qs}` : ''}`;
	const proxy = userConfiguredProxy.trim().replace(/\/$/, '');
	const url = proxy ? `${proxy}/${upstream}` : upstream;
	return { url, headers: { authorization: `Bearer ${tempoToken}` } };
}

/** Derive the sibling `/api/tempo` endpoint from the hosted proxy base. */
function hostedTempoEndpoint(hostedProxyUrl: string): string {
	const trimmed = hostedProxyUrl.replace(/\/+$/, '');
	const suffix = '/api/proxy';
	return trimmed.endsWith(suffix)
		? `${trimmed.slice(0, -suffix.length)}/api/tempo`
		: `${trimmed}/api/tempo`;
}
