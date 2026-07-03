import type React from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import * as styles from './SecurityPage.module.css';

/**
 * Public security & trust hub (ADA-305).
 *
 * Consolidates the architectural facts that make Hoursmith procurement-grade —
 * previously scattered across /sub-processors, /privacy, and code comments —
 * into a single page a procurement reviewer can be sent to. The canonical
 * sub-processor *table* still lives on /sub-processors (kept in sync with
 * docs/sub-processors.md); this page summarises and links to it rather than
 * duplicating the row data.
 *
 * Every claim here must stay true to the actual architecture. When the data
 * flow, region pinning, or retention behaviour changes, update this copy in the
 * same PR.
 */

const LAST_UPDATED = '2026-07-03';
const CONTACT_EMAIL = 'privacy@hoursmith.io';
const GITHUB_URL = 'https://github.com/bcamarneiro/hoursmith';

export const SecurityPage: React.FC = () => {
	usePageTitle('Security & trust');
	return (
		<div className={styles.page}>
			<header className={styles.hero}>
				<h1 className={styles.title}>Security &amp; trust.</h1>
				<p className={styles.lede}>
					Hoursmith is built so the data you care most about — your Jira
					credentials and everything they can reach — never touches our servers.
					This page is the canonical place to send a security or procurement
					reviewer: how data flows, what we store, where it runs, and how you
					stay in control of it.
				</p>
				<p className={styles.meta}>Last updated: {LAST_UPDATED}.</p>
			</header>

			<section className={styles.section}>
				<h2 className={styles.heading}>How your data flows</h2>
				<p className={styles.body}>
					On the free / self-hosted tier, Jira data never leaves your browser.
					On the hosted tier, requests pass through an EU CORS proxy purely
					in-transit so they can reach your Jira instance — nothing is
					inspected, logged, or persisted along the way.
				</p>
				<figure className={styles.diagram} aria-labelledby="data-flow-caption">
					<div className={styles.flow}>
						<div className={styles.node}>
							<span className={styles.nodeTitle}>Your browser</span>
							<span className={styles.nodeNote}>
								Jira token in local storage; requests signed client-side
							</span>
						</div>
						<div className={styles.arrow} aria-hidden="true">
							<span className={styles.arrowLabel}>token attached</span>
							<span className={styles.arrowLine}>→</span>
							<span className={styles.arrowSub}>never persisted in proxy</span>
						</div>
						<div className={styles.node}>
							<span className={styles.nodeTitle}>Hoursmith EU proxy</span>
							<span className={styles.nodeNote}>
								Stateless forward only — no logging, no storage of token or
								response body
							</span>
						</div>
						<div className={styles.arrow} aria-hidden="true">
							<span className={styles.arrowLabel}>forwarded in-transit</span>
							<span className={styles.arrowLine}>→</span>
							<span className={styles.arrowSub}>fra1 region</span>
						</div>
						<div className={styles.node}>
							<span className={styles.nodeTitle}>Your Jira</span>
							<span className={styles.nodeNote}>
								Response returns the same path; parsed in your browser
							</span>
						</div>
					</div>
					<figcaption id="data-flow-caption" className={styles.caption}>
						Your browser attaches your Jira token and signs each request. On the
						hosted tier the request is forwarded by our stateless EU proxy to
						your Jira instance and the response is returned the same way — the
						token and response body are never inspected, logged, or persisted by
						Hoursmith.
					</figcaption>
				</figure>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>What we store server-side</h2>
				<p className={styles.body}>
					The only personal data we hold server-side is the minimum required to
					run authentication and billing. Everything else — issues, worklogs,
					comments, report configurations, saved filters, calendar feeds, team
					setups — lives in your browser's local storage and is never uploaded.
				</p>
				<div className={styles.bodyList}>
					<p className={styles.body}>
						<strong>Auth.</strong> Your email address and authentication
						identifiers, in Supabase (EU, Frankfurt).
					</p>
					<p className={styles.body}>
						<strong>Billing.</strong> The Polar customer and subscription
						identifiers needed to manage your plan. Payment details are handled
						by Polar as Merchant of Record — we never see a card number.
					</p>
					<p className={styles.body}>
						<strong>Nothing from Jira.</strong> No Jira token, issue, worklog,
						or response body is written to any Hoursmith database, log, or
						cache.
					</p>
				</div>
				<p className={styles.body}>
					The full list of third parties that may process data on our behalf,
					with regions and each provider's DPA, is on the{' '}
					<Link className={styles.link} to="/sub-processors">
						sub-processors page
					</Link>
					.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Data protection posture</h2>
				<div className={styles.bodyList}>
					<p className={styles.body}>
						<strong>EU region pin.</strong> Sensitive endpoints (account delete,
						data export, billing webhook) are pinned to the fra1 (Frankfurt)
						region.{' '}
						<em className={styles.footnote}>
							Honest footnote: Edge middleware executes at the visitor's nearest
							region; the pin applies to the server functions that touch stored
							data, not to edge routing.
						</em>
					</p>
					<p className={styles.body}>
						<strong>The waitlist refuses to log emails.</strong> A waitlist
						sign-up is acknowledged without writing the email address to our
						logs.
					</p>
					<p className={styles.body}>
						<strong>Retention that outlives deletion, by design.</strong>{' '}
						Billing and compliance records that we are legally required to keep
						(for example invoices and tax records held by our Merchant of
						Record) are retained independently of your account, so deleting your
						account does not erase records we must retain. Everything not
						subject to a retention obligation is removed.
					</p>
					<p className={styles.body}>
						<strong>Your rights.</strong> To access, export, or delete the data
						we hold, or to exercise any GDPR right, contact{' '}
						<a className={styles.link} href={`mailto:${CONTACT_EMAIL}`}>
							{CONTACT_EMAIL}
						</a>
						. See the{' '}
						<Link className={styles.link} to="/privacy">
							privacy policy
						</Link>{' '}
						for the full statement.
					</p>
				</div>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Data Processing Agreement</h2>
				<p className={styles.body}>
					A Hoursmith Data Processing Agreement is available to hosted-tier
					customers on request — email{' '}
					<a className={styles.link} href={`mailto:${CONTACT_EMAIL}`}>
						{CONTACT_EMAIL}
					</a>{' '}
					and we will send the current DPA for signature. Each sub-processor's
					own DPA is linked from the{' '}
					<Link className={styles.link} to="/sub-processors">
						sub-processors page
					</Link>
					.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Solo founder by design</h2>
				<p className={styles.body}>
					Hoursmith is run by one person, and the architecture is deliberately
					built so that never becomes your risk. You are never locked in.
				</p>
				<div className={styles.bodyList}>
					<p className={styles.body}>
						<strong>Open core.</strong> The application core is MIT-licensed and
						the hosted extras are source-available (BSL). If Hoursmith ever went
						away, the core keeps working and can be self-hosted.
					</p>
					<p className={styles.body}>
						<strong>Self-host in minutes.</strong> The only thing the hosted
						tier adds over self-hosting is a stateless CORS proxy for Jira
						requests. You can run your own — the{' '}
						<a
							className={styles.link}
							href={GITHUB_URL}
							target="_blank"
							rel="noreferrer noopener"
						>
							public repository
						</a>{' '}
						documents how.
					</p>
					<p className={styles.body}>
						<strong>Your data is portable.</strong> Because report and team data
						lives in your browser, there is nothing to extract from us to leave
						— and account/billing data can be exported on request.
					</p>
				</div>
			</section>

			<hr className={styles.divider} />
			<p className={styles.footer}>
				Last updated: {LAST_UPDATED}. Questions from a security or procurement
				review are welcome — email{' '}
				<a className={styles.link} href={`mailto:${CONTACT_EMAIL}`}>
					{CONTACT_EMAIL}
				</a>{' '}
				or open an issue on the public repository.
			</p>
		</div>
	);
};
