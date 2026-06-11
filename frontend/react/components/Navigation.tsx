import type React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { isPremiumBuild } from '../../buildTier';
import { useIsAuthenticated } from '../hooks/useIsAuthenticated';
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
	const isAuthed = useIsAuthenticated();

	return (
		<nav className={styles.nav} aria-label="Primary">
			<div className={styles.navContent}>
				<Link to="/" className={styles.brandLink} aria-label="Hoursmith">
					{/* Billet H lockup. Dark-ink parts use currentColor so the wordmark
					    follows --color-text (iron on light, paper on dark); the ember
					    crossbar + spark stay brand colours in both themes. */}
					<svg
						className={styles.brandLogo}
						viewBox="0 0 360 80"
						role="img"
						aria-label="Hoursmith"
					>
						<g transform="translate(8 8)">
							<rect
								x="2"
								y="6"
								width="11"
								height="52"
								rx="2.6"
								fill="currentColor"
							/>
							<rect
								x="31"
								y="6"
								width="11"
								height="52"
								rx="2.6"
								fill="currentColor"
							/>
							<rect
								x="2"
								y="25"
								width="40"
								height="13"
								rx="2.6"
								fill="#c8431a"
							/>
							<circle cx="48" cy="16" r="2.6" fill="#ee6b2d" />
							<circle cx="52.5" cy="22" r="1.7" fill="#ee6b2d" />
						</g>
						<text
							x="86"
							y="52"
							fontFamily="'Bricolage Grotesque', system-ui, sans-serif"
							fontWeight="700"
							fontSize="40"
							letterSpacing="-1"
						>
							<tspan fill="currentColor">Hour</tspan>
							<tspan fill="#c8431a">smith</tspan>
						</text>
					</svg>
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
						{isAuthed ? (
							<Link
								to="/account"
								className={linkClass('/account')}
								aria-current={isActive('/account') ? 'page' : undefined}
							>
								Account
							</Link>
						) : (
							<Link
								to="/auth/sign-in"
								className={linkClass('/auth/sign-in')}
								aria-current={isActive('/auth/sign-in') ? 'page' : undefined}
							>
								Sign in
							</Link>
						)}
					</div>
				)}
			</div>
		</nav>
	);
};
