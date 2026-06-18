/**
 * Route guard for premium-only pages.
 *
 * If no session, redirects to `/auth/sign-in?redirect=<currentPath>`.
 * Renders nothing while the initial session is loading to avoid flashing
 * the unauthenticated state on refresh.
 *
 * Linear: ADA-256.
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './useAuth';

export function RequireAuth({
	children,
}: {
	children: ReactNode;
}): JSX.Element {
	const { user, isLoading, sessionError } = useAuth();
	const location = useLocation();

	if (isLoading) {
		return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading…</div>;
	}

	if (!user) {
		const target = `${location.pathname}${location.search}`;
		const params = new URLSearchParams({ redirect: target });
		// Carry the reason so the sign-in screen can explain why the user was
		// bounced (expired/failed session) instead of showing a bare login form
		// (ADA-476). Falls back to a generic "auth required" reason.
		params.set('reason', sessionError ? 'session-expired' : 'auth-required');
		return <Navigate to={`/auth/sign-in?${params.toString()}`} replace />;
	}

	return <>{children}</>;
}
