/**
 * Supabase auth context for Hoursmith Premium.
 *
 * Wraps the app and exposes `{ user, session, isLoading, signIn, signUp,
 * signInWithGitHub, signOut }`. The provider holds a single subscription to
 * `onAuthStateChange` so cross-tab sign-outs propagate everywhere.
 *
 * Logging discipline: never log email, token, or password. Sign-in
 * success/failure is logged as a non-PII event name only.
 *
 * Linear: ADA-256.
 */

import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import {
	createContext,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from 'react';
import { getSupabase, hasSupabaseEnv } from './supabaseClient';

const MISSING_ENV_ERROR =
	'Sign-in is temporarily unavailable. Please try again later.';

/**
 * Map raw Supabase auth errors to user-facing copy. Notably, an unconfirmed
 * account surfaces as "Email not confirmed" — without this it read as a generic
 * credentials failure, confusing users who hadn't clicked the email link yet.
 */
function friendlySignInError(message: string): string {
	const m = message.toLowerCase();
	if (m.includes('not confirmed') || m.includes('not been confirmed')) {
		return 'Please confirm your email first — check your inbox for the confirmation link.';
	}
	if (m.includes('invalid login credentials') || m.includes('invalid')) {
		return 'Incorrect email or password.';
	}
	return message;
}

/**
 * Where Supabase should send the user after they click the confirmation link.
 * Uses the current origin so a sign-up on hoursmith.io returns to hoursmith.io
 * (and staging → staging) instead of falling back to Supabase's Site URL. The
 * origin must be on the Supabase redirect allowlist.
 */
function emailRedirectTarget(): string | undefined {
	if (typeof window === 'undefined') return undefined;
	return `${window.location.origin}/auth/callback`;
}

function buildMisconfiguredContext(): AuthContextValue {
	const fail = async () => ({ error: MISSING_ENV_ERROR });
	return {
		user: null,
		session: null,
		isLoading: false,
		sessionError: null,
		signIn: fail,
		signUp: async () => ({
			error: MISSING_ENV_ERROR,
			needsEmailConfirmation: false,
		}),
		signInWithGitHub: fail,
		signOut: async () => {},
	};
}

export interface AuthContextValue {
	user: User | null;
	session: Session | null;
	isLoading: boolean;
	/**
	 * Non-PII signal that the initial session could not be restored (network /
	 * config failure on `getSession`, or a SIGNED_OUT event after having been
	 * signed in). `RequireAuth` reads this to explain the redirect instead of
	 * dropping the user on a bare login screen (ADA-476). `null` when healthy.
	 */
	sessionError: string | null;
	signIn: (
		email: string,
		password: string,
	) => Promise<{ error: string | null }>;
	signUp: (
		email: string,
		password: string,
	) => Promise<{ error: string | null; needsEmailConfirmation: boolean }>;
	signInWithGitHub: (redirectTo?: string) => Promise<{ error: string | null }>;
	signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
	children: ReactNode;
	/** Inject a client for tests. Defaults to the real Supabase client. */
	client?: SupabaseClient;
}

function logEvent(name: string): void {
	// Intentionally no PII. console.info so we never lose sign-in audit trail
	// even in production; payload is just the event name.
	if (typeof console !== 'undefined') {
		console.info(`[auth] ${name}`);
	}
}

export function AuthProvider(props: AuthProviderProps): JSX.Element {
	if (!props.client && !hasSupabaseEnv()) {
		if (typeof console !== 'undefined') {
			console.warn(
				'[auth] supabase_env_missing — running in logged-out fallback mode',
			);
		}
		return (
			<AuthContext.Provider value={buildMisconfiguredContext()}>
				{props.children}
			</AuthContext.Provider>
		);
	}
	return <ConfiguredAuthProvider {...props} />;
}

function ConfiguredAuthProvider({
	children,
	client,
}: AuthProviderProps): JSX.Element {
	const supabase = useMemo(() => client ?? getSupabase(), [client]);
	const [session, setSession] = useState<Session | null>(null);
	const [user, setUser] = useState<User | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [sessionError, setSessionError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		// Track whether we ever had a session, so a later SIGNED_OUT means the
		// session expired (vs. simply never having been signed in).
		let hadSession = false;

		supabase.auth
			.getSession()
			.then(({ data }) => {
				if (cancelled) return;
				setSession(data.session);
				setUser(data.session?.user ?? null);
				hadSession = !!data.session;
				setSessionError(null);
			})
			.catch(() => {
				// Network/config failure — surface a signal so the route guard can
				// explain the redirect instead of failing silently (ADA-476).
				if (cancelled) return;
				setSessionError(
					'We couldn’t restore your session. Please sign in again.',
				);
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});

		const { data: sub } = supabase.auth.onAuthStateChange(
			(event, nextSession) => {
				setSession(nextSession);
				setUser(nextSession?.user ?? null);
				if (nextSession) {
					hadSession = true;
					setSessionError(null);
				} else if (event === 'SIGNED_OUT' && hadSession) {
					// Expired / revoked / cross-tab sign-out after being authenticated.
					hadSession = false;
					setSessionError('Your session expired — please sign in again.');
				}
			},
		);

		return () => {
			cancelled = true;
			sub.subscription.unsubscribe();
		};
	}, [supabase]);

	const signIn = useCallback(
		async (email: string, password: string) => {
			const { error } = await supabase.auth.signInWithPassword({
				email,
				password,
			});
			if (error) {
				logEvent('sign_in_failed');
				return { error: friendlySignInError(error.message) };
			}
			logEvent('sign_in_success');
			return { error: null };
		},
		[supabase],
	);

	const signUp = useCallback(
		async (email: string, password: string) => {
			const { data, error } = await supabase.auth.signUp({
				email,
				password,
				options: { emailRedirectTo: emailRedirectTarget() },
			});
			if (error) {
				logEvent('sign_up_failed');
				return { error: error.message, needsEmailConfirmation: false };
			}
			logEvent('sign_up_success');
			// With Supabase "Confirm email" ON, signUp returns no session — the
			// user must click the emailed link before they can sign in (ADA-291).
			// Guard `data?.session` so a stubbed `{ error: null }` is treated as
			// "needs confirmation" rather than throwing.
			return { error: null, needsEmailConfirmation: !data?.session };
		},
		[supabase],
	);

	const signInWithGitHub = useCallback(
		async (redirectTo?: string) => {
			const { error } = await supabase.auth.signInWithOAuth({
				provider: 'github',
				options: redirectTo ? { redirectTo } : undefined,
			});
			if (error) {
				logEvent('oauth_github_failed');
				return { error: error.message };
			}
			logEvent('oauth_github_redirect');
			return { error: null };
		},
		[supabase],
	);

	const signOut = useCallback(async () => {
		await supabase.auth.signOut();
		logEvent('sign_out');
	}, [supabase]);

	const value = useMemo<AuthContextValue>(
		() => ({
			user,
			session,
			isLoading,
			sessionError,
			signIn,
			signUp,
			signInWithGitHub,
			signOut,
		}),
		[
			user,
			session,
			isLoading,
			sessionError,
			signIn,
			signUp,
			signInWithGitHub,
			signOut,
		],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
