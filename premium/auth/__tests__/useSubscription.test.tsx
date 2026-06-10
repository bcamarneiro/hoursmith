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
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../useAuth', () => ({
	useAuth: () => ({
		user: { id: 'u1', email: 'a@b.com' },
		session: { access_token: 't' },
	}),
}));

vi.mock('../../../frontend/services/proxyUrlBridge', () => ({
	setHostedProxyUrl: vi.fn(),
	setSupabaseAccessToken: vi.fn(),
}));

import { useSubscription } from '../useSubscription';

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
