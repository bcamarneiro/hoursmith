/**
 * Tests for the auth pages (ADA-309, ADA-291).
 *
 * - SignUp shows a "check your inbox" state when Supabase requires email
 *   confirmation (signUp resolves needsEmailConfirmation:true) instead of
 *   navigating to /account.
 * - The broken GitHub OAuth button is not rendered on either page (ADA-309).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignInPage } from '../SignInPage';
import { SignUpPage } from '../SignUpPage';

const signUp = vi.fn();
const signIn = vi.fn();

vi.mock('../useAuth', () => ({
	useAuth: () => ({
		signUp,
		signIn,
		signInWithGitHub: vi.fn(),
		signOut: vi.fn(),
		user: null,
		session: null,
		isLoading: false,
	}),
}));

afterEach(() => {
	vi.clearAllMocks();
});

function fill(label: string, value: string): void {
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('SignUpPage (ADA-291)', () => {
	it('shows the confirm-email state when signUp needs confirmation', async () => {
		signUp.mockResolvedValue({ error: null, needsEmailConfirmation: true });
		render(
			<MemoryRouter>
				<SignUpPage />
			</MemoryRouter>,
		);
		fill('Email', 'new@user.com');
		fill('Password', 'password123');
		fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
		await waitFor(() =>
			expect(screen.getByText('Check your inbox')).toBeInTheDocument(),
		);
		expect(screen.getByText(/new@user\.com/)).toBeInTheDocument();
	});

	it('does not render a GitHub OAuth button (ADA-309)', () => {
		render(
			<MemoryRouter>
				<SignUpPage />
			</MemoryRouter>,
		);
		expect(screen.queryByText(/GitHub/i)).toBeNull();
	});
});

describe('SignInPage (ADA-309)', () => {
	it('does not render a GitHub OAuth button', () => {
		render(
			<MemoryRouter>
				<SignInPage />
			</MemoryRouter>,
		);
		expect(screen.queryByText(/GitHub/i)).toBeNull();
	});

	it('surfaces a sign-in error with role="alert"', async () => {
		signIn.mockResolvedValue({ error: 'Invalid login credentials' });
		render(
			<MemoryRouter>
				<SignInPage />
			</MemoryRouter>,
		);
		fill('Email', 'a@b.com');
		fill('Password', 'whatever1');
		fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
		await waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent(
				'Invalid login credentials',
			),
		);
	});
});
