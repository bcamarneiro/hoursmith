/**
 * Tests for the global Navigation chrome (ADA-299).
 *
 * Pricing must always be present and reachable from any page; the Sign in /
 * Account cluster shows only in premium builds (the Free tier has no accounts).
 * `buildTier` is mocked so both build modes are exercised deterministically,
 * independent of the suite-wide __BUILD_TIER__ define.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Navigation } from '../Navigation';

let mockIsPremium = false;

vi.mock('../../../buildTier', () => ({
	isPremiumBuild: () => mockIsPremium,
}));

function renderNav(initialPath = '/') {
	return render(
		<MemoryRouter initialEntries={[initialPath]}>
			<Navigation />
		</MemoryRouter>,
	);
}

afterEach(() => {
	mockIsPremium = false;
});

describe('Navigation', () => {
	it('always shows the Pricing link', () => {
		renderNav();
		expect(screen.getByRole('link', { name: 'Pricing' })).toHaveAttribute(
			'href',
			'/pricing',
		);
	});

	it('marks the active route with aria-current="page"', () => {
		renderNav('/pricing');
		expect(screen.getByRole('link', { name: 'Pricing' })).toHaveAttribute(
			'aria-current',
			'page',
		);
		expect(screen.getByRole('link', { name: 'Reports' })).not.toHaveAttribute(
			'aria-current',
		);
	});

	it('hides the Sign in / Account cluster in the free build', () => {
		mockIsPremium = false;
		renderNav();
		expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
		expect(screen.queryByRole('link', { name: 'Account' })).toBeNull();
	});

	it('shows Sign in and Account in the premium build', () => {
		mockIsPremium = true;
		renderNav();
		expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
			'href',
			'/auth/sign-in',
		);
		expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute(
			'href',
			'/account',
		);
	});
});
