import type React from 'react';
import { Link } from 'react-router-dom';
import { useConfigStore } from '../../stores/useConfigStore';
import { PWAInstallCard } from '../components/home/PWAInstallCard';
import { usePageTitle } from '../hooks/usePageTitle';
import { buildDemoTeam, DEMO_WEEKDAYS } from './demoFixture';
import * as styles from './HomePage.module.css';

const GITHUB_URL = 'https://github.com/bcamarneiro/jira-timesheet-report';
const DAY_INITIALS = ['M', 'T', 'W', 'T', 'F'];

// First name only — keeps the hero preview compact and scannable.
function firstName(displayName: string): string {
	return displayName.split(' ')[0];
}

/**
 * Compact, non-interactive team-rollup preview rendered inline (no screenshot
 * asset). Reuses the same synthetic fixture as the `/demo` route so the hero
 * and the live demo always tell the same story. The missed day (0h) renders
 * red — that's the "chase the gap" value moment, above the fold.
 */
const HeroRollup: React.FC = () => {
	const team = buildDemoTeam();
	return (
		<figure className={styles.heroVisual} aria-label="Example team rollup">
			<figcaption className={styles.rollupCaption}>
				Team rollup · week of May 18
			</figcaption>
			<table className={styles.rollupTable}>
				<thead>
					<tr>
						<th className={styles.rollupCorner}>Developer</th>
						{DAY_INITIALS.map((d, i) => (
							<th key={DEMO_WEEKDAYS[i]} className={styles.rollupDayHead}>
								{d}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{team.map((member) => (
						<tr key={member.email}>
							<td className={styles.rollupName}>
								{firstName(member.displayName)}
							</td>
							{DEMO_WEEKDAYS.map((day) => {
								const hours = member.dailyHours.get(day) ?? 0;
								return (
									<td
										key={day}
										className={
											hours > 0 ? styles.rollupCell : styles.rollupCellMissed
										}
									>
										{hours > 0 ? `${hours}h` : '—'}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</figure>
	);
};

export const HomePage: React.FC = () => {
	usePageTitle('Home');
	const jiraHost = useConfigStore((state) => state.config.jiraHost);
	const isConfigured = !!jiraHost;

	return (
		<div className={styles.container}>
			<section className={styles.hero}>
				<div className={styles.heroContent}>
					<div className={styles.eyebrow}>For team leads who live in Jira</div>
					<h1 className={styles.title}>
						Chase your team's missing Jira worklogs before invoice day.
					</h1>
					<p className={styles.description}>
						A team-lead's dashboard that pulls everyone's logged hours into one
						view. Spot missed days at a glance, then export clean CSVs at
						month-end. Browser-only — your team's data stays where it is.
					</p>

					<div className={styles.buttonContainer}>
						{isConfigured ? (
							<>
								<Link to="/my-week" className={styles.primaryButton}>
									Open My Week
								</Link>
								<Link to="/pricing" className={styles.secondaryButton}>
									See pricing
								</Link>
							</>
						) : (
							<>
								<Link to="/demo" className={styles.primaryButton}>
									Try the demo
								</Link>
								<Link to="/pricing" className={styles.secondaryButton}>
									See pricing
								</Link>
							</>
						)}
					</div>

					<p className={styles.priceAnchor}>
						Free to self-host · Hosted €29/year · Lead from €60/year
					</p>

					<div className={styles.tertiaryLinks}>
						{!isConfigured && (
							<Link to="/my-week" className={styles.tertiaryLink}>
								Open the app
							</Link>
						)}
						<a
							href={GITHUB_URL}
							className={styles.tertiaryLink}
							target="_blank"
							rel="noreferrer"
						>
							View on GitHub
						</a>
					</div>
				</div>

				<HeroRollup />
			</section>

			<section className={styles.whyBlock}>
				<div className={styles.whyLabel}>Why this exists</div>
				<p className={styles.whyText}>
					I'm Bruno. I lead a small team at a consultancy in Porto. Every Friday
					at 4pm I open Hoursmith, scan the week, and message whoever forgot to
					log Thursday. On the 1st I export a CSV for my client's finance team.
					Hoursmith is what I built to stop dreading invoice day.
				</p>
				<p className={styles.whySignature}>
					— Bruno Camarneiro, Future Sketches
				</p>
			</section>

			<section className={styles.section}>
				<div className={styles.sectionHeading}>
					<h2 className={styles.sectionTitle}>Two clear surfaces</h2>
					<p className={styles.sectionDescription}>
						My Week is your personal home base for closing the week; Reports is
						the shared surface for team compliance and month-end exports.
					</p>
				</div>
				<div className={styles.featureGrid}>
					<div className={styles.featureItem}>
						<div className={styles.featureTitle}>My Week</div>
						<div className={styles.featureDescription}>
							Weekly gap triage, copy-previous-week flows, suggestions,
							templates, pins, notes, and quick exports.
						</div>
					</div>
					<div className={styles.featureItem}>
						<div className={styles.featureTitle}>Reports</div>
						<div className={styles.featureDescription}>
							Weekly team compliance plus monthly calendar reporting with
							per-user drill-down and CSV output.
						</div>
					</div>
					<div className={styles.featureItem}>
						<div className={styles.featureTitle}>Settings</div>
						<div className={styles.featureDescription}>
							Connection details, JQL, permissions, calendar feeds, theme,
							rounding, and import/export of local config.
						</div>
					</div>
				</div>
			</section>

			<section className={styles.section}>
				<div className={styles.sectionHeading}>
					<h2 className={styles.sectionTitle}>
						Why teams roll this out quickly
					</h2>
					<p className={styles.sectionDescription}>
						Setup is lightweight, sharing a safe configuration takes minutes,
						and the hosted path adds no new operational work.
					</p>
				</div>
				<div className={styles.adoptionGrid}>
					<div className={styles.adoptionCard}>
						<div className={styles.adoptionTitle}>No backend to maintain</div>
						<div className={styles.adoptionDescription}>
							The app stays static-host friendly, so Vercel or any simple static
							host is a realistic rollout path.
						</div>
					</div>
					<div className={styles.adoptionCard}>
						<div className={styles.adoptionTitle}>
							Import/export already exists
						</div>
						<div className={styles.adoptionDescription}>
							Pass around safe setup packs and restore local backups without
							retyping every field.
						</div>
					</div>
					<div className={styles.adoptionCard}>
						<div className={styles.adoptionTitle}>
							Trust comes from consistency
						</div>
						<div className={styles.adoptionDescription}>
							My Week and Reports keep matching on real data, not just looking
							polished in isolation.
						</div>
					</div>
				</div>
			</section>

			<section className={styles.section}>
				<div className={styles.sectionHeading}>
					<h2 className={styles.sectionTitle}>
						Install it like a lightweight app
					</h2>
					<p className={styles.sectionDescription}>
						A hosted workspace gets much more usable when it can live in a dock,
						launcher, or home screen instead of a random browser tab.
					</p>
				</div>
				<PWAInstallCard />
			</section>

			{!isConfigured && (
				<section className={styles.quickStart}>
					<h2 className={styles.quickStartTitle}>Quick Start</h2>
					<ol className={styles.steps}>
						<li className={styles.step}>
							<span className={styles.stepNumber}>1</span>
							<span className={styles.stepText}>
								Go to <Link to="/settings">Settings</Link> and enter your Jira
								host, email, and API token — or import a backup JSON
							</span>
						</li>
						<li className={styles.step}>
							<span className={styles.stepNumber}>2</span>
							<span className={styles.stepText}>
								Test the connection so you know auth, permissions, and CORS are
								all in a good state
							</span>
						</li>
						<li className={styles.step}>
							<span className={styles.stepNumber}>3</span>
							<span className={styles.stepText}>
								Use My Week for the weekly close and Reports for team/month
								visibility
							</span>
						</li>
					</ol>
				</section>
			)}

			{isConfigured && (
				<section className={styles.quickStart}>
					<h2 className={styles.quickStartTitle}>Suggested next moves</h2>
					<ol className={styles.steps}>
						<li className={styles.step}>
							<span className={styles.stepNumber}>1</span>
							<span className={styles.stepText}>
								Open <Link to="/my-week">My Week</Link> to close the week, fill
								gaps, and reuse prior work
							</span>
						</li>
						<li className={styles.step}>
							<span className={styles.stepNumber}>2</span>
							<span className={styles.stepText}>
								Use <Link to="/reports">Reports</Link> when you need a team
								compliance or monthly view
							</span>
						</li>
						<li className={styles.step}>
							<span className={styles.stepNumber}>3</span>
							<span className={styles.stepText}>
								Export or back up your local setup from{' '}
								<Link to="/settings">Settings</Link> before sharing the app with
								teammates
							</span>
						</li>
					</ol>
				</section>
			)}
		</div>
	);
};
