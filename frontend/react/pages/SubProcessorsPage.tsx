import type React from 'react';
import { usePageTitle } from '../hooks/usePageTitle';
import * as styles from './SubProcessorsPage.module.css';

/**
 * Public sub-processors page. Mirrors `docs/sub-processors.md`.
 *
 * Trade-off: this is a hand-translated TSX rendering of the markdown source
 * rather than a runtime markdown render. The upside is zero new dependencies
 * and a styling pass that matches the rest of the app. The downside is that
 * `docs/sub-processors.md` and this file must be kept in sync by hand. The
 * markdown remains the source of truth for legal review; update both when the
 * sub-processor list changes (expected cadence: quarterly at most).
 */

const LAST_UPDATED = '2026-06-07';

interface SubProcessorRow {
	name: string;
	purpose: string;
	region: string;
	dpa: { label: string; href: string };
}

const ACTIVE_SUB_PROCESSORS: SubProcessorRow[] = [
	{
		name: 'Vercel',
		purpose:
			'Application hosting and serverless functions. All compute is pinned to the fra1 region.',
		region: 'EU (Frankfurt, Germany)',
		dpa: {
			label: 'vercel.com/legal/dpa',
			href: 'https://vercel.com/legal/dpa',
		},
	},
	{
		name: 'Supabase',
		purpose:
			'Authentication (email/password and GitHub OAuth) and Postgres database storing only the profiles and subscriptions tables.',
		region: 'EU (Frankfurt, Germany)',
		dpa: {
			label: 'supabase.com/legal/dpa',
			href: 'https://supabase.com/legal/dpa',
		},
	},
	{
		name: 'Polar',
		purpose:
			'Merchant of Record for Premium subscriptions: checkout, payment processing, invoicing, and EU VAT calculation, collection, and remittance.',
		region:
			'United States (Polar Software Inc.), transferred under Standard Contractual Clauses',
		dpa: {
			label: 'polar.sh/legal/data-processing-addendum',
			href: 'https://polar.sh/legal/data-processing-addendum',
		},
	},
	{
		name: 'PostHog',
		purpose:
			'Cookieless product analytics: page views and a small set of product events. No autocapture, no session recording, and no persistent identifiers — so no consent banner is required.',
		region: 'EU (Germany), via PostHog EU Cloud',
		dpa: { label: 'posthog.com/dpa', href: 'https://posthog.com/dpa' },
	},
];

export const SubProcessorsPage: React.FC = () => {
	usePageTitle('Sub-processors');
	return (
		<div className={styles.page}>
			<header className={styles.hero}>
				<h1 className={styles.title}>Sub-processors.</h1>
				<p className={styles.lede}>
					Hoursmith uses a small number of third-party sub-processors to deliver
					the hosted service. This page lists every sub-processor that may
					process personal data on our behalf, along with the purpose of the
					processing, the region where the data is handled, and a link to each
					provider's Data Processing Agreement (DPA).
				</p>
				<p className={styles.lede}>
					This list is kept current as our stack evolves. When the active
					customer base warrants it, material changes to this list — for
					example, a new sub-processor, a new processing region, or an expansion
					of processing scope — will be communicated by email to active
					subscribers in advance of the change taking effect.
				</p>
				<p className={styles.meta}>Last updated: {LAST_UPDATED}.</p>
			</header>

			<section className={styles.section}>
				<h2 className={styles.heading}>Active sub-processors</h2>
				<div className={styles.tableWrap}>
					<table className={styles.table}>
						<thead>
							<tr>
								<th scope="col">Sub-processor</th>
								<th scope="col">Purpose</th>
								<th scope="col">Region</th>
								<th scope="col">DPA</th>
							</tr>
						</thead>
						<tbody>
							{ACTIVE_SUB_PROCESSORS.map((row) => (
								<tr key={row.name}>
									<td>
										<strong>{row.name}</strong>
									</td>
									<td>{row.purpose}</td>
									<td>{row.region}</td>
									<td>
										<a
											className={styles.link}
											href={row.dpa.href}
											target="_blank"
											rel="noreferrer noopener"
										>
											{row.dpa.label}
										</a>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>

				<h3 className={styles.subheading}>Not yet active</h3>
				<ul className={styles.notActive}>
					<li>
						<strong>Resend</strong> — transactional email delivery. Not
						currently in use. This entry will be moved to the active table when
						the integration ships, and active subscribers will be notified by
						email before it begins processing data.
					</li>
				</ul>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>What we don't process</h2>
				<p className={styles.body}>
					Hoursmith is designed so that the data you care most about never
					leaves your browser and is never sent to our servers. The hosted
					service exists to handle authentication, billing, and a stateless CORS
					proxy for Jira requests — nothing else.
				</p>

				<div className={styles.bodyList}>
					<p className={styles.body}>
						<strong>Jira API tokens.</strong> Your Jira API token is stored in
						your browser's local storage and is attached to Jira requests
						client-side. The hosted CORS proxy forwards the request to your Jira
						instance and returns the response without inspecting, logging, or
						persisting the token or the response body.
					</p>
					<p className={styles.body}>
						<strong>Jira workspace data.</strong> Issues, worklogs, comments,
						attachments, sprints, and any other content fetched from your Jira
						instance are processed entirely in the browser. No Jira payload is
						written to any Hoursmith database, log, or cache.
					</p>
					<p className={styles.body}>
						<strong>User settings, templates, and favorites.</strong> Report
						configurations, saved filters, favorite issues, calendar mappings,
						and team setups live in your browser's local storage. There is no
						cloud sync; nothing is uploaded.
					</p>
					<p className={styles.body}>
						<strong>Calendar feeds.</strong> ICS feeds for absences, holidays,
						and shared availability are fetched and parsed in the browser. The
						hosted proxy may relay the fetch when CORS requires it but does not
						retain feed contents.
					</p>
				</div>

				<p className={styles.body}>
					The only personal data we store server-side is the minimum required to
					operate auth and billing: your email address and authentication
					identifiers in Supabase, and the Polar customer and subscription
					identifiers needed to manage your plan.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Changes to this list</h2>
				<p className={styles.body}>
					Any addition or removal of a sub-processor will appear on this page
					with the "Last updated" date below adjusted to match. Material changes
					— a new sub-processor, a new processing region, or an expansion of the
					categories of data processed — will additionally be communicated by
					email to active subscribers in advance of taking effect.
				</p>
				<p className={styles.body}>
					Historical changes can be reviewed in the git history of this page.
				</p>
			</section>

			<hr className={styles.divider} />
			<p className={styles.footer}>
				Last updated: {LAST_UPDATED}. Questions: open an issue on the public
				repository, or contact us via the email listed in the privacy policy.
			</p>
		</div>
	);
};
