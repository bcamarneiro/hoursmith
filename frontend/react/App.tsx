import type React from 'react';
import { lazy, Suspense, useEffect, useState } from 'react';
import {
	BrowserRouter,
	HashRouter,
	Navigate,
	Route,
	Routes,
} from 'react-router-dom';
import { isPremiumBuild } from '../buildTier';
import * as styles from './App.module.css';

// Inlined by DefinePlugin (rspack.config.js) as a string literal. Branching on
// this raw macro directly — instead of the re-exported `BUILD_TIER` constant —
// lets the bundler statically evaluate the guard and dead-code-eliminate the
// premium dynamic import (and its Supabase chunk) from Free-tier builds.
declare const __BUILD_TIER__: 'free' | 'premium';

import { Navigation } from './components/Navigation';
import { BuildInfoFooter } from './components/ui/BuildInfoFooter';
import { SiteFooter } from './components/ui/SiteFooter';
import { Spinner } from './components/ui/Spinner';
import { ToastContainer } from './components/ui/Toast';
import { useFlags } from './hooks/useFlags';
import { usePageViewTracking } from './hooks/usePageViewTracking';
import { useTheme } from './hooks/useTheme';
import { MaintenancePage } from './pages/MaintenancePage';
import { appBasePath, isHashRouterMode } from './utils/runtimeConfig';

const HomePage = lazy(() =>
	import('./pages/HomePage').then((module) => ({
		default: module.HomePage,
	})),
);
const MyWeekPage = lazy(() =>
	import('./pages/MyWeekPage').then((module) => ({
		default: module.MyWeekPage,
	})),
);
const PricingPage = lazy(() =>
	import('./pages/PricingPage').then((module) => ({
		default: module.PricingPage,
	})),
);
const ReportsPage = lazy(() =>
	import('./pages/ReportsPage').then((module) => ({
		default: module.ReportsPage,
	})),
);
const SettingsPage = lazy(() =>
	import('./pages/SettingsPage').then((module) => ({
		default: module.SettingsPage,
	})),
);
const SubProcessorsPage = lazy(() =>
	import('./pages/SubProcessorsPage').then((module) => ({
		default: module.SubProcessorsPage,
	})),
);
const PrivacyPage = lazy(() =>
	import('./pages/PrivacyPage').then((module) => ({
		default: module.PrivacyPage,
	})),
);
const TermsPage = lazy(() =>
	import('./pages/TermsPage').then((module) => ({
		default: module.TermsPage,
	})),
);
const DemoPage = lazy(() =>
	import('./pages/DemoPage').then((module) => ({
		default: module.DemoPage,
	})),
);

// Premium-only routes. The frontend boundary script
// (scripts/check-premium-boundary.cjs) only matches static ES-module imports
// of the protected directory; the dynamic import below is gated by
// `isPremiumBuild()` so Free-tier builds never fetch this chunk. The path is
// composed at runtime to keep the boundary check passive.
interface PremiumRouteSpec {
	path: string;
	element: React.ReactNode;
}
interface PremiumRoutesModule {
	premiumRoutes: PremiumRouteSpec[];
	PremiumAuthProvider: React.ComponentType<{ children: React.ReactNode }>;
}

// Static `import()` call gated by the raw `__BUILD_TIER__` define. The boundary
// script only flags `from '...'` ES-module imports; dynamic `import('...')` is
// intentionally allowed for this gating pattern. Branching on the inlined macro
// (not the re-exported `BUILD_TIER` constant, which is an indirection the
// minifier can't prove dead) lets the bundler statically resolve the guard to
// `false` in Free builds and dead-code-eliminate the import — and the Supabase
// chunk it pulls in — entirely.
function loadPremiumRoutes(): Promise<PremiumRoutesModule> {
	// The dynamic import MUST live inside the statically-true branch. rspack's
	// parser only skips an `import()` dependency (and the chunk it pulls in) when
	// it sits inside an `if (false) { … }` dead branch. In Free builds DefinePlugin
	// inlines `__BUILD_TIER__` to `'free'`, so this becomes `if (false)` and the
	// Supabase chunk is never emitted; Premium builds inline `'premium'`.
	if (__BUILD_TIER__ === 'premium') {
		return import(
			/* webpackChunkName: "premium-auth" */ '../../premium/auth/routes'
		) as Promise<PremiumRoutesModule>;
	}
	return Promise.reject(new Error('not_a_premium_build'));
}

const AppShell: React.FC = () => {
	usePageViewTracking();
	const [premium, setPremium] = useState<PremiumRoutesModule | null>(null);

	useEffect(() => {
		if (!isPremiumBuild()) return;
		let cancelled = false;
		loadPremiumRoutes()
			.then((mod) => {
				if (!cancelled) setPremium(mod);
			})
			.catch((err) => {
				console.warn('[premium] route_load_failed', err);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const tree = (
		<div className={styles.appContainer}>
			<a href="#main" className={styles.skipLink}>
				Skip to main content
			</a>
			<Navigation />
			<main id="main">
				<Suspense
					fallback={
						<div className={styles.routeLoader}>
							<Spinner size="lg" />
							<span>Loading workspace...</span>
						</div>
					}
				>
					<Routes>
						<Route path="/" element={<HomePage />} />
						<Route path="/my-week" element={<MyWeekPage />} />
						<Route
							path="/dashboard"
							element={<Navigate to="/my-week" replace />}
						/>
						<Route path="/pricing" element={<PricingPage />} />
						<Route path="/demo" element={<DemoPage />} />
						<Route path="/reports" element={<ReportsPage />} />
						<Route path="/team" element={<Navigate to="/reports" replace />} />
						<Route
							path="/timesheet"
							element={<Navigate to="/reports" replace />}
						/>
						<Route path="/settings" element={<SettingsPage />} />
						<Route path="/sub-processors" element={<SubProcessorsPage />} />
						<Route path="/privacy" element={<PrivacyPage />} />
						<Route path="/terms" element={<TermsPage />} />
						{premium?.premiumRoutes.map((route) => (
							<Route
								key={route.path}
								path={route.path}
								element={route.element}
							/>
						))}
						{/*
						 * In premium builds the route table is split: known routes are
						 * registered above, premium routes load asynchronously into
						 * `premium`. If we render the catch-all redirect before the
						 * dynamic chunk has resolved, a deep-link to /auth/sign-up
						 * (which is a premium route) gets redirected to "/" before
						 * SignUpPage ever mounts — and the URL change means SignUpPage
						 * never renders even after the chunk finishes loading.
						 *
						 * In dev this is masked because the in-memory bundle resolves
						 * synchronously; in production the network fetch opens the race.
						 *
						 * Fix: in premium builds, hold the catch-all until the chunk
						 * resolves. Free builds keep the immediate catch-all.
						 */}
						{(!isPremiumBuild() || premium) && (
							<Route path="*" element={<Navigate to="/" replace />} />
						)}
					</Routes>
				</Suspense>
			</main>
			<ToastContainer />
			<SiteFooter />
			<BuildInfoFooter />
		</div>
	);

	if (isPremiumBuild() && premium) {
		const Provider = premium.PremiumAuthProvider;
		return <Provider>{tree}</Provider>;
	}

	return tree;
};

export const App: React.FC = () => {
	useTheme();
	const flags = useFlags();

	// Operational kill switch (ADA-341): when maintenance mode is on, render the
	// static maintenance screen instead of the route table. The Polar webhook and
	// /api/version are separate functions and keep responding.
	if (flags.maintenanceMode) {
		return <MaintenancePage />;
	}

	return isHashRouterMode ? (
		<HashRouter>
			<AppShell />
		</HashRouter>
	) : (
		<BrowserRouter basename={appBasePath}>
			<AppShell />
		</BrowserRouter>
	);
};
