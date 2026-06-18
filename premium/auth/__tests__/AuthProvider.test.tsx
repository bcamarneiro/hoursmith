/**
 * AuthProvider behaviour: bootstrapping, sign-in, sign-out.
 *
 * The Supabase client is mocked. We never call the real SDK.
 *
 * Linear: ADA-256.
 */

import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../AuthProvider';
import { useAuth } from '../useAuth';

interface MockClient {
	auth: {
		getSession: ReturnType<typeof vi.fn>;
		onAuthStateChange: ReturnType<typeof vi.fn>;
		signInWithPassword: ReturnType<typeof vi.fn>;
		signUp: ReturnType<typeof vi.fn>;
		signInWithOAuth: ReturnType<typeof vi.fn>;
		signOut: ReturnType<typeof vi.fn>;
	};
	__emit: (session: Session | null, event?: string) => void;
}

function makeClient(initial: Session | null = null): MockClient {
	const listeners: Array<(event: string, s: Session | null) => void> = [];
	const client: MockClient = {
		auth: {
			getSession: vi.fn().mockResolvedValue({ data: { session: initial } }),
			onAuthStateChange: vi.fn(
				(cb: (event: string, s: Session | null) => void) => {
					listeners.push(cb);
					return {
						data: { subscription: { unsubscribe: vi.fn() } },
					};
				},
			),
			signInWithPassword: vi.fn(),
			signUp: vi.fn(),
			signInWithOAuth: vi.fn(),
			signOut: vi.fn().mockResolvedValue({ error: null }),
		},
		__emit: (session, event = 'SIGNED_IN') => {
			for (const cb of listeners) cb(event, session);
		},
	};
	return client;
}

function HookProbe(): JSX.Element {
	const { user, isLoading, sessionError, signIn, signOut } = useAuth();
	return (
		<div>
			<span data-testid="loading">{isLoading ? 'yes' : 'no'}</span>
			<span data-testid="user">{user?.email ?? 'none'}</span>
			<span data-testid="session-error">{sessionError ?? 'none'}</span>
			<button type="button" onClick={() => signIn('a@b.com', 'pw')}>
				signin
			</button>
			<button type="button" onClick={() => signOut()}>
				signout
			</button>
		</div>
	);
}

const fakeUser: User = {
	id: 'user-1',
	email: 'a@b.com',
	app_metadata: {},
	user_metadata: {},
	aud: 'authenticated',
	created_at: '2026-01-01T00:00:00.000Z',
} as User;

const fakeSession: Session = {
	access_token: 'token',
	refresh_token: 'refresh',
	expires_in: 3600,
	token_type: 'bearer',
	user: fakeUser,
} as Session;

describe('AuthProvider', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('starts with no user when there is no session', async () => {
		const client = makeClient(null);
		render(
			<AuthProvider client={client as unknown as SupabaseClient}>
				<HookProbe />
			</AuthProvider>,
		);

		await waitFor(() =>
			expect(screen.getByTestId('loading').textContent).toBe('no'),
		);
		expect(screen.getByTestId('user').textContent).toBe('none');
	});

	it('sets the user after a successful sign-in', async () => {
		const client = makeClient(null);
		client.auth.signInWithPassword.mockImplementation(async () => {
			client.__emit(fakeSession);
			return { error: null, data: { session: fakeSession, user: fakeUser } };
		});

		render(
			<AuthProvider client={client as unknown as SupabaseClient}>
				<HookProbe />
			</AuthProvider>,
		);

		await waitFor(() =>
			expect(screen.getByTestId('loading').textContent).toBe('no'),
		);

		await act(async () => {
			screen.getByText('signin').click();
		});

		await waitFor(() =>
			expect(screen.getByTestId('user').textContent).toBe('a@b.com'),
		);
		expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
			email: 'a@b.com',
			password: 'pw',
		});
	});

	it('clears the user after sign-out', async () => {
		const client = makeClient(fakeSession);
		client.auth.signOut.mockImplementation(async () => {
			client.__emit(null);
			return { error: null };
		});

		render(
			<AuthProvider client={client as unknown as SupabaseClient}>
				<HookProbe />
			</AuthProvider>,
		);

		await waitFor(() =>
			expect(screen.getByTestId('user').textContent).toBe('a@b.com'),
		);

		await act(async () => {
			screen.getByText('signout').click();
		});

		await waitFor(() =>
			expect(screen.getByTestId('user').textContent).toBe('none'),
		);
	});

	it('surfaces an error string when sign-in fails (without logging PII)', async () => {
		const client = makeClient(null);
		client.auth.signInWithPassword.mockResolvedValue({
			error: { message: 'Invalid login credentials' },
			data: { session: null, user: null },
		});

		let signInResult: { error: string | null } | null = null;
		function Probe(): JSX.Element {
			const { signIn } = useAuth();
			return (
				<button
					type="button"
					onClick={async () => {
						signInResult = await signIn('x@y.com', 'bad');
					}}
				>
					go
				</button>
			);
		}

		render(
			<AuthProvider client={client as unknown as SupabaseClient}>
				<Probe />
			</AuthProvider>,
		);

		await act(async () => {
			screen.getByText('go').click();
		});

		await waitFor(() =>
			expect(signInResult?.error).toBe('Incorrect email or password.'),
		);
	});

	it('surfaces a sessionError when getSession fails (ADA-476)', async () => {
		const client = makeClient(null);
		client.auth.getSession.mockRejectedValue(new Error('network down'));

		render(
			<AuthProvider client={client as unknown as SupabaseClient}>
				<HookProbe />
			</AuthProvider>,
		);

		await waitFor(() =>
			expect(screen.getByTestId('loading').textContent).toBe('no'),
		);
		expect(screen.getByTestId('session-error').textContent).toMatch(
			/sign in again/i,
		);
	});

	it('sets a session-expired signal on SIGNED_OUT after having been signed in (ADA-476)', async () => {
		const client = makeClient(fakeSession);
		render(
			<AuthProvider client={client as unknown as SupabaseClient}>
				<HookProbe />
			</AuthProvider>,
		);

		await waitFor(() =>
			expect(screen.getByTestId('user').textContent).toBe('a@b.com'),
		);

		await act(async () => {
			client.__emit(null, 'SIGNED_OUT');
		});

		await waitFor(() =>
			expect(screen.getByTestId('session-error').textContent).toMatch(
				/session expired/i,
			),
		);
	});

	it('does NOT set a session-expired signal when never signed in', async () => {
		const client = makeClient(null);
		render(
			<AuthProvider client={client as unknown as SupabaseClient}>
				<HookProbe />
			</AuthProvider>,
		);

		await waitFor(() =>
			expect(screen.getByTestId('loading').textContent).toBe('no'),
		);

		await act(async () => {
			client.__emit(null, 'SIGNED_OUT');
		});

		expect(screen.getByTestId('session-error').textContent).toBe('none');
	});

	it('maps an unconfirmed-email sign-in to a confirm-your-email message', async () => {
		const client = makeClient(null);
		client.auth.signInWithPassword.mockResolvedValue({
			error: { message: 'Email not confirmed' },
			data: { session: null, user: null },
		});

		let signInResult: { error: string | null } | null = null;
		function Probe(): JSX.Element {
			const { signIn } = useAuth();
			return (
				<button
					type="button"
					onClick={async () => {
						signInResult = await signIn('x@y.com', 'pw');
					}}
				>
					go
				</button>
			);
		}

		render(
			<AuthProvider client={client as unknown as SupabaseClient}>
				<Probe />
			</AuthProvider>,
		);

		await act(async () => {
			screen.getByText('go').click();
		});

		await waitFor(() =>
			expect(signInResult?.error).toContain('confirm your email'),
		);
	});
});
