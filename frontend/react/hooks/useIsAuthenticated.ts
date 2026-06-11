import { useSyncExternalStore } from 'react';
import {
	getProxyOverrideState,
	subscribe,
} from '../../services/proxyUrlBridge';

/**
 * Whether a Premium user is currently signed in.
 *
 * Observed from the cross-tier `proxyUrlBridge`, into which Premium auth pushes
 * the Supabase access token for any logged-in user (`useSubscription`, mounted
 * globally via `PremiumAuthProvider`). This lets Free-tier marketing/nav
 * components reflect auth state without importing `premium/*` (premium-boundary).
 * Always `false` in Free builds — nothing pushes a token there. See ADA-379.
 */
export function useIsAuthenticated(): boolean {
	const state = useSyncExternalStore(
		subscribe,
		getProxyOverrideState,
		getProxyOverrideState,
	);
	return state.supabaseAccessToken !== null;
}
