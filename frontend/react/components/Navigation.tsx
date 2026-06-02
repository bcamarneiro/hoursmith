import type React from 'react';
import { Link, useLocation } from 'react-router-dom';
import * as styles from './Navigation.module.css';

export const Navigation: React.FC = () => {
	const location = useLocation();

	const getLinkStyle = (path: string) => {
		return location.pathname === path ? styles.navLinkActive : styles.navLink;
	};

	return (
		<nav className={styles.nav}>
			<div className={styles.navContent}>
				<Link to="/" className={styles.brandLink}>
					<span className={styles.brand}>Hoursmith</span>
				</Link>
				<div className={styles.navLinks}>
					<Link to="/my-week" className={getLinkStyle('/my-week')}>
						My Week
					</Link>
					<Link to="/reports" className={getLinkStyle('/reports')}>
						Reports
					</Link>
					<Link to="/settings" className={getLinkStyle('/settings')}>
						Settings
					</Link>
				</div>
			</div>
		</nav>
	);
};
