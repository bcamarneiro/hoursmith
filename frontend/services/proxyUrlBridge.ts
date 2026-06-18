/**
 * Cross-tier bridge between Premium auth state and the network layer.
 *
 * The Free-tier bundle owns the proxy URL via `useConfigStore.config.corsProxy`.
 * Premium needs to override this with a hosted endpoint when the user has an
 * active subscription — but the Free-tier code can't import anything under
 * `/premium/` (see `scripts/check-premium-boundary.cjs`). This module is the
 * one-way seam:
 *
 *   premium auth ── setHostedProxyUrl()/clear() ──▶ this bridge ──▶ resolveProxyUrl()
 *
 * The bridge keeps state in module scope. `subscribe(listener)` lets React
 * hooks rerender when the hosted URL flips so the dashboard fetcher reconfigures
 * mid-session.
 *
 * Why not a Zustand store? We want this to be importable from anywhere
 * without dragging in React. The shape is too small to justify a store.
 *
 * Linear: ADA-273.
 */

export interface ProxyOverrideState {
	/**
	 * The fully-qualified hosted CORS proxy URL the user is entitled to, or
	 * `null` when the user is signed out / on Free / sub not active. Always
	 * normalised with no trailing slash so callers can append paths safely.
	 */
	hostedProxyUrl: string | null;
	/**
	 * When `true`, the user explicitly asked to keep their self-configured
	 * proxy URL even though they're entitled to the hosted one (escape hatch).
	 * Respected only when `hostedProxyUrl` is set.
	 */
	userOverride: boolean;
	/**
	 * Supabase access token of the currently signed-in user. The hosted
	 * proxy uses this to verify entitlement on each request. Held in memory
	 * only — never persisted.
	 */
	supabaseAccessToken: string | null;
}

const STATE: ProxyOverrideState = {
	hostedProxyUrl: null,
	userOverride: false,
	supabaseAccessToken: null,
};

/**
 * Compute the hosted proxy URL the app should hit. Reads `VITE_APP_ORIGIN`
 * (tests / dev override) and falls back to `window.location.origin` so prod
 * "just works" wherever it's deployed. Mirrors `getHostedProxyUrl()` in
 * `premium/auth/useSubscription.ts` — kept here so the bridge can self-bootstrap
 * without importing across the premium boundary.
 */
function computeHostedProxyUrl(): string | null {
	if (typeof window === 'undefined') return null;
	const fromEnv =
		typeof process !== 'undefined' && process.env?.VITE_APP_ORIGIN
			? process.env.VITE_APP_ORIGIN
			: null;
	const origin = fromEnv || window.location.origin;
	if (!origin) return null;
	return `${origin.replace(/\/+$/, '')}/api/proxy`;
}

/**
 * Read the access token from any persisted Supabase session in localStorage.
 *
 * The browser Supabase client (`premium/auth/supabaseClient.ts`) is created with
 * `persistSession: true`, which stores the session as JSON under a key of the
 * form `sb-<project-ref>-auth-token`. On a COLD page load the React effect in
 * `useSubscription` that populates this bridge has not run yet when the first
 * worklog query fires — so the gateway would see no hosted URL and go *direct*
 * to Atlassian, CORS-failing before React Query retries through `/api/proxy`
 * (ADA-447). Reading the persisted token synchronously at module init lets us
 * route through the hosted proxy from the very first request for an already
 * signed-in premium user. The server still enforces entitlement (401 if not
 * premium), and `useSubscription` clears the bridge on a confirmed non-active
 * subscription — so a logged-in free user safely falls back to their own proxy.
 *
 * Pure localStorage read of a generic value: no import from `premium/**`, so the
 * cross-tier boundary stays intact.
 */
function readPersistedSupabaseToken(): string | null {
	if (typeof window === 'undefined') return null;
	let storage: Storage;
	try {
		storage = window.localStorage;
		if (!storage) return null;
	} catch {
		// Access can throw (privacy mode, blocked storage). Treat as signed-out.
		return null;
	}
	try {
		for (let i = 0; i < storage.length; i += 1) {
			const key = storage.key(i);
			if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
			const raw = storage.getItem(key);
			if (!raw) continue;
			const parsed = JSON.parse(raw) as {
				access_token?: unknown;
				currentSession?: { access_token?: unknown };
			} | null;
			const token =
				parsed?.access_token ?? parsed?.currentSession?.access_token ?? null;
			if (typeof token === 'string' && token.length > 0) return token;
		}
	} catch {
		// Malformed/partial entry — ignore and stay signed-out.
		return null;
	}
	return null;
}

/**
 * Synchronously bootstrap the bridge from a persisted Supabase session so the
 * very first Jira query on a cold load routes through the hosted proxy for an
 * already-authenticated user, instead of racing the `useSubscription` effect and
 * firing a direct-to-Atlassian (CORS-failing) request first (ADA-447).
 */
function bootstrapFromPersistedSession(): void {
	const token = readPersistedSupabaseToken();
	if (!token) return;
	STATE.supabaseAccessToken = token;
	STATE.hostedProxyUrl = computeHostedProxyUrl();
}

bootstrapFromPersistedSession();

// Cached frozen snapshot — returned by `getProxyOverrideState()` until a
// mutation triggers `emit()`. Required by `useSyncExternalStore`: the getter
// must return a stable reference between renders, otherwise React flags an
// infinite loop because every read produces a "new" value.
let snapshot: ProxyOverrideState = { ...STATE };

type Listener = (state: ProxyOverrideState) => void;
const listeners = new Set<Listener>();

function emit(): void {
	snapshot = { ...STATE };
	for (const listener of listeners) listener(snapshot);
}

/** Subscribe to bridge changes. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Read the current snapshot (sync). Useful for `useSyncExternalStore`. */
export function getProxyOverrideState(): ProxyOverrideState {
	return snapshot;
}

/**
 * Premium pushes the hosted proxy URL here when the user has an active sub.
 * Pass `null` to clear (signed out, sub lapsed, free tier).
 */
export function setHostedProxyUrl(url: string | null): void {
	const normalised = url ? url.replace(/\/+$/, '') : null;
	if (STATE.hostedProxyUrl === normalised) return;
	STATE.hostedProxyUrl = normalised;
	emit();
}

/**
 * Toggle the user's "use my self-configured proxy anyway" escape hatch.
 * No-ops when the user isn't subscribed (override only matters then).
 */
export function setUserOverride(enabled: boolean): void {
	if (STATE.userOverride === enabled) return;
	STATE.userOverride = enabled;
	emit();
}

/** Premium pushes the current Supabase access token here. Pass `null` to clear. */
export function setSupabaseAccessToken(token: string | null): void {
	if (STATE.supabaseAccessToken === token) return;
	STATE.supabaseAccessToken = token;
	emit();
}

/**
 * Compute the effective proxy URL. Inputs:
 *   - `userConfiguredProxy` — the value of `config.corsProxy` from settings.
 *
 * Rules (mirrors ADA-273 spec):
 *   1. If the bridge has a hosted URL AND the user has NOT overridden →
 *      return the hosted URL.
 *   2. Otherwise → return the user-configured value verbatim.
 *
 * Note: returning an empty string is a valid result (means "no proxy, talk
 * to Jira directly"). Callers preserve that behaviour today.
 */
export function resolveProxyUrl(userConfiguredProxy: string): string {
	if (STATE.hostedProxyUrl && !STATE.userOverride) {
		return STATE.hostedProxyUrl;
	}
	return userConfiguredProxy;
}

/** Whether the network layer is currently routed through the hosted proxy. */
export function isUsingHostedProxy(): boolean {
	return STATE.hostedProxyUrl !== null && !STATE.userOverride;
}

/** Test-only — reset to defaults. */
export function __resetProxyBridgeForTests(): void {
	STATE.hostedProxyUrl = null;
	STATE.userOverride = false;
	STATE.supabaseAccessToken = null;
	snapshot = { ...STATE };
	listeners.clear();
}
