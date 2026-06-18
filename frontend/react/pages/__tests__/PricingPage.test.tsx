/**
 * Tests for the public PricingPage (ADA-304 / ADA-451).
 *
 * Focus: the Hosted tier CTA must not show the pre-launch waitlist embed to a
 * user who is already signed in (and therefore effectively a subscriber). A
 * logged-in user gets a "current plan" state with a link to /account instead.
 *
 * Auth is driven through the real cross-tier `proxyUrlBridge` (the same signal
 * `useIsAuthenticated` reads) rather than mocking the hook, so we exercise the
 * actual premium-boundary-safe path. `buildTier` is mocked premium so the
 * page behaves like the deployed hosted build.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	__resetProxyBridgeForTests,
	setSupabaseAccessToken,
} from '../../../services/proxyUrlBridge';
import { __resetFlagsCache } from '../../hooks/useFlags';
import { PricingPage } from '../PricingPage';

vi.mock('../../../buildTier', () => ({
	isPremiumBuild: () => true,
}));

function renderPricing() {
	return render(
		<MemoryRouter>
			<PricingPage />
		</MemoryRouter>,
	);
}

beforeEach(() => {
	// Default flags (checkout enabled, paywall not open for me) would normally
	// render the waitlist embed for the Hosted/Lead tiers.
	__resetFlagsCache();
	__resetProxyBridgeForTests();
});

afterEach(() => {
	__resetProxyBridgeForTests();
	vi.restoreAllMocks();
});

describe('PricingPage — Hosted CTA (ADA-451)', () => {
	it('shows the launch waitlist CTA for a logged-out visitor', () => {
		renderPricing();
		// Waitlist embed is present; no current-plan state.
		expect(
			screen.getByRole('button', { name: 'Notify me' }),
		).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: 'Manage your plan' })).toBeNull();
	});

	it('shows a current-plan state (not the waitlist) for a signed-in user', () => {
		setSupabaseAccessToken('a-token');
		renderPricing();

		const manage = screen.getByRole('link', { name: 'Manage your plan' });
		expect(manage).toHaveAttribute('href', '/account');
		expect(screen.getByText("You're on Hosted.")).toBeInTheDocument();

		// The confusing pre-launch waitlist CTA must be gone for subscribers.
		expect(screen.queryByRole('button', { name: 'Notify me' })).toBeNull();
	});
});
