/**
 * `useSubscription()` — read the caller's `subscriptions` row from
 * `/api/account/subscription` and expose `{ tier, status, isActive }`.
 *
 * Cadence (ADA-273 spec):
 *   - fetch once on mount,
 *   - refetch on every auth-state change (signed in/out, token refresh),
 *   - refetch when the window/tab regains focus.
 *
 * The subscription row is intentionally NOT persisted to localStorage. A
 * lapsed subscription has to lose hosted-proxy access immediately on the next
 * fetch — caching across reloads would let users keep premium routing for a
 * full TTL window. Memory only.
 *
 * Side-effect: pushes the hosted proxy URL into the cross-tier
 * `proxyUrlBridge` whenever the active state flips. The bridge is the seam
 * between Premium auth state and the Free-tier network layer; see
 * `frontend/services/proxyUrlBridge.ts`.
 *
 * Linear: ADA-273.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	setHostedProxyUrl,
	setSupabaseAccessToken,
} from '../../frontend/services/proxyUrlBridge';
import { useAuth } from './useAuth';

export type SubscriptionStatus =
	| 'active'
	| 'past_due'
	| 'canceled'
	| 'incomplete'
	| 'trialing'
	| 'unpaid';

export type SubscriptionTier = 'free' | 'premium';

export interface SubscriptionView {
	tier: SubscriptionTier | null;
	status: SubscriptionStatus | null;
	currentPeriodEnd: string | null;
	isActive: boolean;
	isLoading: boolean;
	error: string | null;
	refetch: () => void;
}

interface SubscriptionResponseBody {
	subscription: {
		tier: string;
		status: string;
		current_period_end: string | null;
	} | null;
}

/**
 * Compute the hosted proxy URL the entitled user should hit. Reads from
 * `VITE_APP_ORIGIN` so tests / dev can override; falls back to the runtime
 * `window.location.origin` so production "just works" wherever it's deployed.
 */
function getHostedProxyUrl(): string | null {
	if (typeof window === 'undefined') return null;
	const fromEnv =
		typeof process !== 'undefined' && process.env?.VITE_APP_ORIGIN
			? process.env.VITE_APP_ORIGIN
			: null;
	const origin = fromEnv || window.location.origin;
	if (!origin) return null;
	return `${origin.replace(/\/+$/, '')}/api/proxy`;
}

export function useSubscription(): SubscriptionView {
	const { session, user, isLoading: authLoading } = useAuth();
	const accessToken = session?.access_token ?? null;
	const userId = user?.id ?? null;
	const [body, setBody] = useState<SubscriptionResponseBody | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refetchTick, setRefetchTick] = useState(0);

	const refetch = useCallback(() => setRefetchTick((n) => n + 1), []);

	useEffect(() => {
		// Reference refetchTick so the effect re-runs when `refetch()` bumps it.
		void refetchTick;
		if (!accessToken || !userId) {
			setBody(null);
			setError(null);
			setIsLoading(false);
			return;
		}
		let cancelled = false;
		setIsLoading(true);
		setError(null);
		fetch('/api/account/subscription', {
			headers: { authorization: `Bearer ${accessToken}` },
		})
			.then(async (res) => {
				if (!res.ok) throw new Error(`subscription_fetch_failed_${res.status}`);
				return (await res.json()) as SubscriptionResponseBody;
			})
			.then((next) => {
				if (cancelled) return;
				setBody(next);
			})
			.catch((err: Error) => {
				if (cancelled) return;
				setBody(null);
				setError(err.message);
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [accessToken, userId, refetchTick]);

	// Refetch on focus so a subscription that lapsed in another tab / via the
	// Stripe Portal reverts the network layer on the next interaction.
	useEffect(() => {
		if (!accessToken) return;
		function onFocus(): void {
			refetch();
		}
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	}, [accessToken, refetch]);

	const view = useMemo<SubscriptionView>(() => {
		const sub = body?.subscription ?? null;
		const tier = (sub?.tier as SubscriptionTier | undefined) ?? null;
		const status = (sub?.status as SubscriptionStatus | undefined) ?? null;
		// `past_due` is entitled during the dunning grace window (ADA-371): Polar
		// retries the failed renewal charge over ~2 weeks and only then emits
		// `subscription.revoked`, which our webhook maps to `tier:'free'`. That
		// revoke is the real cutoff — so a transient card decline keeps proxy
		// access (and the "Update payment method" CTA) working until revoked.
		// Status-based grace; kept identical to the server entitlement check.
		const isActive =
			tier === 'premium' &&
			(status === 'active' || status === 'trialing' || status === 'past_due');
		return {
			tier,
			status,
			currentPeriodEnd: sub?.current_period_end ?? null,
			isActive,
			isLoading,
			error,
			refetch,
		};
	}, [body, isLoading, error, refetch]);

	// Route Jira traffic through the hosted proxy as soon as the user is
	// authenticated AND the subscription is still loading OR confirmed active.
	// The hosted URL is just `${origin}/api/proxy` and the server enforces
	// entitlement (401 if not), so routing optimistically during the
	// subscription fetch avoids a startup race where early Jira requests fired
	// before `isActive` resolved, fell back to "direct", and failed CORS
	// (ADA-382). Only a *confirmed* non-active subscription clears it, so a
	// logged-in free user still falls back to their own proxy.
	useEffect(() => {
		// While AuthProvider is still rehydrating the persisted session on a cold
		// load, `accessToken` is transiently null even for a signed-in user. In
		// that window `proxyUrlBridge` has already bootstrapped the hosted URL from
		// the persisted session — clearing it here would make the first worklog
		// queries fire direct-to-Atlassian and CORS-fail before auth resolves
		// (ADA-447). Wait until auth has resolved before setting/clearing.
		if (authLoading) return;
		const routeHosted = !!accessToken && (view.isLoading || view.isActive);
		setHostedProxyUrl(routeHosted ? getHostedProxyUrl() : null);
	}, [authLoading, accessToken, view.isLoading, view.isActive]);

	// Keep the cross-tier bridge in sync with the Supabase access token so the
	// network layer can attach it to hosted-proxy requests without importing
	// Premium auth state directly (boundary guard).
	useEffect(() => {
		// Same rehydration guard as above: don't overwrite the bridge token that
		// was bootstrapped from the persisted session while auth is still loading,
		// otherwise the hosted-proxy requests fire without the Supabase JWT and 401
		// before auth resolves (ADA-447).
		if (authLoading) return;
		setSupabaseAccessToken(accessToken);
	}, [authLoading, accessToken]);

	return view;
}
