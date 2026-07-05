import type React from 'react';
import { Link } from 'react-router-dom';
import { trackEvent } from '../../../analytics';
import { isPremiumBuild } from '../../../buildTier';
import { PremiumWaitlistForm } from '../marketing/PremiumWaitlistForm';
import * as styles from './FirstRunOnboarding.module.css';

/**
 * First-run path chooser (ADA-470).
 *
 * The landing copy targets non-technical team leads, but the only *available*
 * tier is self-host, which needs a terminal + a local proxy — and Hosted (no
 * setup) isn't purchasable yet. Rather than drop every first-time visitor
 * straight into a token/proxy form full of dev jargon, name the fork honestly:
 * Hosted (zero setup) for non-devs vs. self-host for developers. The full setup
 * form still renders below untouched — this only adds an honest signpost.
 */
interface Props {
	/** Reveal-intent for the self-host path: the caller dismisses the chooser so
	 *  the setup form below becomes the focus. */
	onChooseSelfHost: () => void;
}

export const FirstRunOnboarding: React.FC<Props> = ({ onChooseSelfHost }) => {
	const premium = isPremiumBuild();

	return (
		<section className={styles.onboarding} aria-labelledby="first-run-title">
			<div className={styles.intro}>
				<p className={styles.kicker}>First time here</p>
				<h2 id="first-run-title">Two ways to start</h2>
				<p className={styles.lede}>
					Hoursmith runs in your browser. Pick the path that fits how you work —
					you can switch later.
				</p>
			</div>

			<div className={styles.paths}>
				<div className={styles.pathCard}>
					<h3 className={styles.pathTitle}>Zero setup — Hosted</h3>
					<p className={styles.pathBody}>
						No terminal, no install. Your Jira requests are forwarded through
						our EU proxy in-transit (never stored). Best if you don't run
						developer tools.
					</p>
					{premium ? (
						<Link
							to="/auth/sign-up"
							className={styles.primaryCta}
							onClick={() =>
								trackEvent('onboarding_path_selected', { path: 'hosted' })
							}
						>
							Create account
						</Link>
					) : (
						<div className={styles.hostedSoon}>
							<span className={styles.badge}>Coming soon</span>
							<PremiumWaitlistForm
								source="in-app-settings"
								heading="Hosted (zero setup) is on the way — leave your email and we'll tell you the moment it opens."
							/>
						</div>
					)}
				</div>

				<div className={styles.pathCard}>
					<h3 className={styles.pathTitle}>Self-host — for developers</h3>
					<p className={styles.pathBody}>
						Free forever, fully private. Needs a terminal: clone the repo, run
						the app, and start the local proxy (<code>npm run cors-proxy</code>
						). Then add your Jira host and API token in the form below.
					</p>
					<button
						type="button"
						className={styles.secondaryCta}
						onClick={() => {
							trackEvent('onboarding_path_selected', { path: 'self-host' });
							onChooseSelfHost();
						}}
					>
						I'll self-host — show the setup form
					</button>
				</div>
			</div>
		</section>
	);
};
