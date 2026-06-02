import type React from 'react';
import * as styles from './MaintenancePage.module.css';

/**
 * Shown when the `maintenance_mode` kill switch is on (ADA-341).
 *
 * Renders inside the normal SPA shell and returns the usual 200 (it's the
 * static index.html) — deliberately NOT a 503, so search engines don't
 * deindex during a short window. The Polar webhook and /api/version are
 * separate functions and keep responding regardless of this screen.
 */
export const MaintenancePage: React.FC = () => {
	return (
		<div className={styles.maintenance}>
			<div className={styles.card}>
				<h1 className={styles.title}>Hoursmith is down for maintenance</h1>
				<p className={styles.body}>
					We&rsquo;ll be back shortly. Thanks for your patience.
				</p>
				<p className={styles.footer}>
					Status updates at{' '}
					<a className={styles.link} href="https://hoursmith.io">
						hoursmith.io
					</a>
					.
				</p>
			</div>
		</div>
	);
};
