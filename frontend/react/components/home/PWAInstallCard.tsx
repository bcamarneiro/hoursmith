import type React from 'react';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { Button } from '../ui/Button';
import * as styles from './PWAInstallCard.module.css';

export const PWAInstallCard: React.FC = () => {
	const {
		isInstalled,
		canInstall,
		hasDeferredPrompt,
		shouldShowInstallCard,
		install,
		dismissInstallPrompt,
	} = usePWAInstall();

	if (isInstalled) {
		return (
			<div className={styles.card}>
				<div className={styles.header}>
					<span className={`${styles.statusBadge} ${styles.ready}`}>
						Installed
					</span>
					<h3>App install is already active</h3>
				</div>
				<p>
					This workspace is already running as an installed app on this device.
					You can launch it from your dock, launcher, or home screen.
				</p>
			</div>
		);
	}

	if (!shouldShowInstallCard) {
		return null;
	}

	return (
		<div className={styles.card}>
			<div className={styles.header}>
				<span className={`${styles.statusBadge} ${styles.pending}`}>
					Installable
				</span>
				<h3>Keep this workspace one click away</h3>
			</div>
			<p>
				Installing the app makes Hoursmith feel much closer to a desktop app. It
				keeps My Week and Reports easy to reopen without hunting for a tab.
			</p>
			<ul className={styles.list}>
				<li>Local settings stay in the browser on this device</li>
				<li>The installed shell opens faster for repeat use</li>
				<li>
					If the button is not ready yet, your browser can still install it from
					the address bar or app menu
				</li>
			</ul>
			<div className={styles.actions}>
				<Button
					type="button"
					onClick={() => {
						void install();
					}}
					disabled={!canInstall}
				>
					{canInstall ? 'Install app' : 'Waiting for browser prompt'}
				</Button>
				<Button
					type="button"
					variant="secondary"
					onClick={dismissInstallPrompt}
				>
					Dismiss
				</Button>
			</div>
			{!hasDeferredPrompt ? (
				<p className={styles.helpText}>
					The browser has not exposed an install prompt yet. That is normal on
					some platforms and on first load.
				</p>
			) : null}
		</div>
	);
};
