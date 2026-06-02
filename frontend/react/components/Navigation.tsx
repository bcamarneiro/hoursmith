import type React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { isPremiumBuild } from '../../buildTier';
import * as styles from './Navigation.module.css';

/**
 * Primary nav items, shown in every build. Pricing is the path from a
 * logged-out visitor to monetization, so it lives in the always-visible chrome
 * (ADA-299).
 */
const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
	{ to: '/my-week', label: 'My Week' },
	{ to: '/reports', label: 'Reports' },
	{ to: '/pricing', label: 'Pricing' },
	{ to: '/settings', label: 'Settings' },
];

export const Navigation: React.FC = () => {
	const location = useLocation();
	const isActive = (path: string) => location.pathname === path;
	const linkClass = (path: string) =>
		isActive(path) ? styles.navLinkActive : styles.navLink;

	// Sign in / Account cluster (ADA-299). Only premium builds have accounts, so
	// it's gated on isPremiumBuild(). Links reference the auth routes by string
	// (the paths premium/auth/routes.tsx registers), so frontend/ never imports
	// premium/* and check:premium-boundary stays green.
	const showAuth = isPremiumBuild();

	return (
		<nav className={styles.nav} aria-label="Primary">
			<div className={styles.navContent}>
				<Link to="/" className={styles.brandLink}>
					<span className={styles.brand}>Hoursmith</span>
				</Link>
				<div className={styles.navLinks}>
					{NAV_ITEMS.map((item) => (
						<Link
							key={item.to}
							to={item.to}
							className={linkClass(item.to)}
							aria-current={isActive(item.to) ? 'page' : undefined}
						>
							{item.label}
						</Link>
					))}
				</div>
				{showAuth && (
					<div className={styles.authCluster}>
						<Link
							to="/auth/sign-in"
							className={linkClass('/auth/sign-in')}
							aria-current={isActive('/auth/sign-in') ? 'page' : undefined}
						>
							Sign in
						</Link>
						<Link
							to="/account"
							className={linkClass('/account')}
							aria-current={isActive('/account') ? 'page' : undefined}
						>
							Account
						</Link>
					</div>
				)}
			</div>
		</nav>
	);
};
