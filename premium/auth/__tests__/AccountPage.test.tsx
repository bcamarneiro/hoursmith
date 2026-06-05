/**
 * Tests for the Account page launch polish (ADA-365):
 *   - premium tier renders as "Hosted" (not the generic "Premium")
 *   - subscription status renders a human label (not the raw enum)
 *   - post-checkout ?upgrade=success shows a confirmation banner
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AccountPage } from '../AccountPage';

vi.mock('../useAuth', () => ({
	useAuth: () => ({
		user: { id: 'u1', email: 'a@b.com', created_at: '2026-01-01T00:00:00Z' },
		session: { access_token: 't' },
		signOut: vi.fn(),
	}),
}));

vi.mock('../../../frontend/react/hooks/useFlags', () => ({
	useFlags: () => ({ checkoutEnabled: true, paywallOpenForMe: true }),
}));

vi.mock(
	'../../../frontend/react/components/marketing/PremiumWaitlistForm',
	() => ({ PremiumWaitlistForm: () => null }),
);

vi.mock('../supabaseClient', () => ({
	getSupabase: () => ({
		from: () => ({
			select: () => ({
				eq: () => ({
					maybeSingle: () =>
						Promise.resolve({
							data: {
								tier: 'premium',
								status: 'active',
								current_period_end: '2026-12-06T00:00:00.000Z',
							},
							error: null,
						}),
				}),
			}),
		}),
	}),
}));

describe('AccountPage (ADA-365)', () => {
	it('labels a premium subscription as Hosted with a human status', async () => {
		render(
			<MemoryRouter initialEntries={['/account']}>
				<AccountPage />
			</MemoryRouter>,
		);
		expect(await screen.findByText('Hosted')).toBeTruthy();
		expect(screen.getByText('Active')).toBeTruthy();
	});

	it('shows the checkout confirmation banner on ?upgrade=success', async () => {
		render(
			<MemoryRouter initialEntries={['/account?upgrade=success']}>
				<AccountPage />
			</MemoryRouter>,
		);
		expect(
			await screen.findByText(/Payment received — welcome to Hosted/),
		).toBeTruthy();
	});
});
