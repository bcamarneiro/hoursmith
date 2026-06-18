/**
 * Tests for `useSubscription` entitlement computation (ADA-273, ADA-371).
 *
 * Focus: which subscription statuses flip `isActive` on. `past_due` must stay
 * entitled during the Polar dunning grace window (ADA-371) so a transient card
 * decline does not instantly cut hosted-proxy access — this must agree with the
 * server entitlement check in `premium/api/_lib/entitlement.ts`.
 *
 * `useAuth` and the cross-tier proxy bridge are mocked; `fetch` is stubbed to
 * return the subscription row under test.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable auth mock so individual tests can drive `isLoading` / `session`
// (needed for the ADA-447 rehydration-guard test). Defaults to a signed-in,
// resolved session so the existing entitlement tests behave as before.
const authState = vi.hoisted(() => ({
	current: {
		user: { id: 'u1', email: 'a@b.com' } as {
			id: string;
			email: string;
		} | null,
		session: { access_token: 't' } as { access_token: string } | null,
		isLoading: false,
	},
}));

vi.mock('../useAuth', () => ({
	useAuth: () => authState.current,
}));

vi.mock('../../../frontend/services/proxyUrlBridge', () => ({
	setHostedProxyUrl: vi.fn(),
	setSupabaseAccessToken: vi.fn(),
}));

import { setHostedProxyUrl } from '../../../frontend/services/proxyUrlBridge';
import { useSubscription } from '../useSubscription';

beforeEach(() => {
	vi.mocked(setHostedProxyUrl).mockClear();
	authState.current = {
		user: { id: 'u1', email: 'a@b.com' },
		session: { access_token: 't' },
		isLoading: false,
	};
});

function mockSubscriptionFetch(
	subscription: {
		tier: string;
		status: string;
		current_period_end?: string | null;
	} | null,
): void {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ subscription }),
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('useSubscription isActive (ADA-371 dunning grace)', () => {
	const entitled = ['active', 'trialing', 'past_due'] as const;
	for (const status of entitled) {
		it(`treats premium + ${status} as active/entitled`, async () => {
			mockSubscriptionFetch({ tier: 'premium', status });
			const { result } = renderHook(() => useSubscription());
			await waitFor(() => expect(result.current.isActive).toBe(true));
			expect(result.current.status).toBe(status);
			expect(result.current.tier).toBe('premium');
		});
	}

	const notEntitled = ['canceled', 'unpaid', 'incomplete'] as const;
	for (const status of notEntitled) {
		it(`treats premium + ${status} as NOT entitled`, async () => {
			mockSubscriptionFetch({ tier: 'premium', status });
			const { result } = renderHook(() => useSubscription());
			await waitFor(() => expect(result.current.isLoading).toBe(false));
			expect(result.current.isActive).toBe(false);
		});
	}

	it('treats a free tier as NOT entitled even when status is active', async () => {
		mockSubscriptionFetch({ tier: 'free', status: 'active' });
		const { result } = renderHook(() => useSubscription());
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.isActive).toBe(false);
	});
});

describe('useSubscription hosted-proxy bridge (ADA-447 rehydration guard)', () => {
	it('does NOT clear the bridge while auth is still rehydrating', async () => {
		// Cold load: AuthProvider hasn't resolved the persisted session yet, so
		// session is null but isLoading is true. proxyUrlBridge has already
		// bootstrapped the hosted URL from localStorage — clearing it here is the
		// ADA-447 regression that made worklog queries fire direct-to-Atlassian.
		authState.current = { user: null, session: null, isLoading: true };
		mockSubscriptionFetch(null);
		renderHook(() => useSubscription());
		await new Promise((r) => setTimeout(r, 0));
		// Must not have cleared (or otherwise touched) the bootstrapped bridge.
		expect(setHostedProxyUrl).not.toHaveBeenCalled();
	});

	it('clears the bridge once auth resolves to signed-out', async () => {
		authState.current = { user: null, session: null, isLoading: false };
		mockSubscriptionFetch(null);
		renderHook(() => useSubscription());
		await waitFor(() => expect(setHostedProxyUrl).toHaveBeenCalledWith(null));
	});
});
