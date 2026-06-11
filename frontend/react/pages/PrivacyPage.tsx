import type React from 'react';
import { usePageTitle } from '../hooks/usePageTitle';
import * as styles from './LegalPage.module.css';

/**
 * Public Privacy Policy page. Mirrors `docs/privacy.md`.
 *
 * Trade-off: this is a hand-translated TSX rendering of the markdown source
 * rather than a runtime markdown render. The upside is zero new dependencies
 * and a styling pass that matches the rest of the app. The downside is that
 * `docs/privacy.md` and this file must be kept in sync by hand. The markdown
 * remains the source of truth for legal review; update both when the policy
 * changes (expected cadence: when material processing changes ship).
 */

const EFFECTIVE_DATE = '2026-06-07';
// TODO(ADA-283): replace once support@hoursmith.io is provisioned.
const CONTACT_EMAIL = 'privacy@hoursmith.io';

export const PrivacyPage: React.FC = () => {
	usePageTitle('Privacy Policy');
	return (
		<div className={styles.page}>
			<header className={styles.hero}>
				<h1 className={styles.title}>Privacy Policy</h1>
				<p className={styles.meta}>Effective date: {EFFECTIVE_DATE}.</p>
				<p className={styles.lede}>
					This Privacy Policy explains how Hoursmith collects, uses, and
					protects personal data when you use the hosted service at
					hoursmith.io.
				</p>
				<p className={styles.body}>
					The data controller is <strong>Future Sketches</strong>, established
					in <strong>Portugal</strong>. Contact: <code>{CONTACT_EMAIL}</code>.
				</p>
				<p className={styles.body}>
					Hoursmith is a Jira worklog dashboard. The product is designed so that
					the data you care most about — your Jira tokens, your worklog content,
					your report configurations — never leaves your browser and is never
					sent to our servers. This policy describes the small amount of
					personal data we do process to operate authentication, billing, and
					the hosted CORS proxy.
				</p>
			</header>

			<section className={styles.section}>
				<h2 className={styles.heading}>What we collect</h2>
				<p className={styles.body}>
					We collect the minimum data needed to operate the service.
				</p>
				<p className={styles.body}>
					<strong>Account data.</strong> When you create a Hoursmith account we
					store your email address and an authentication identifier through our
					auth provider, Supabase. If you sign in with GitHub OAuth we also
					store your GitHub user ID. No password is ever stored in plaintext.
				</p>
				<p className={styles.body}>
					<strong>Billing data.</strong> Premium is sold through{' '}
					<strong>Polar</strong> (Polar Software Inc.), which acts as our{' '}
					<strong>Merchant of Record</strong>. When you upgrade, Polar — as the
					seller of record — collects and stores your name, billing address,
					payment instrument and tax identifier (if you provide one) on its own
					systems, issues your invoice, and handles VAT. Polar is an independent
					controller for that payment and tax data. From Polar we receive and
					store only a customer ID, subscription ID, current period end, and
					subscription status. We never see or store your card number.
				</p>
				<p className={styles.body}>
					<strong>Operational logs.</strong> Vercel produces standard server
					logs that include request paths, timestamps, response codes, and the
					IP address that made each request. These logs are retained by Vercel
					under their data-retention policy and are used only for security and
					abuse detection.
				</p>
				<p className={styles.body}>
					<strong>Audit log.</strong> A small server-side <code>audit_log</code>{' '}
					table records material account events (account deletion, data export).
					Entries reference a user ID and an event type. No request bodies or
					tokens are written.
				</p>
				<p className={styles.body}>
					<strong>Analytics.</strong> When PostHog product analytics is enabled
					it records page views and a small set of product events (such as
					starting checkout) to help us improve the product. It runs cookieless
					with no persistent identifiers, no autocapture, and no session
					recording, so it never captures your Jira data and no consent banner
					is required. PostHog processes this in the EU.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>What we do not collect</h2>
				<p className={styles.body}>
					Hoursmith does not store any of the following server-side:
				</p>
				<ul className={styles.bulletList}>
					<li>
						<strong>Jira API tokens.</strong> Your token is held in your
						browser's local storage and attached to Jira requests client-side.
						The hosted CORS proxy forwards the request and returns the response
						without inspecting, logging, or persisting the token.
					</li>
					<li>
						<strong>Jira workspace data.</strong> Issues, worklogs, comments,
						attachments, sprints, and any other Jira content are processed
						entirely in the browser.
					</li>
					<li>
						<strong>User settings and templates.</strong> Report configurations,
						saved filters, favorite issues, calendar mappings, and team setups
						live in your browser's local storage. There is no cloud sync.
					</li>
					<li>
						<strong>Calendar feed contents.</strong> ICS feeds are fetched and
						parsed in the browser. The hosted proxy may relay the fetch when
						CORS requires it but does not retain feed contents.
					</li>
				</ul>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Lawful basis for processing</h2>
				<p className={styles.body}>
					We rely on the following lawful bases under Article 6 GDPR:
				</p>
				<ul className={styles.bulletList}>
					<li>
						<strong>Contract (Article 6(1)(b)):</strong> to provide the service
						you signed up for, including authentication, billing, and the hosted
						CORS proxy.
					</li>
					<li>
						<strong>Legitimate interest (Article 6(1)(f)):</strong> to detect
						abuse, protect the service from misuse, and improve product quality
						through aggregated analytics. You can object to this processing at
						any time.
					</li>
					<li>
						<strong>Legal obligation (Article 6(1)(c)):</strong> to comply with
						our own accounting and tax record-keeping obligations. Invoicing to
						you and the associated VAT records are handled by Polar as Merchant
						of Record.
					</li>
				</ul>
				<p className={styles.body}>
					We do not rely on consent for any processing other than optional
					marketing communications (which we do not currently send).
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Who we share data with</h2>
				<p className={styles.body}>
					We use a small set of sub-processors to operate the service. The full
					list, with regions and links to each provider's Data Processing
					Agreement, is at <a href="/sub-processors">/sub-processors</a>.
				</p>
				<p className={styles.body}>
					We do not sell personal data. We do not share personal data with
					advertisers. We do not transfer personal data outside the EU except
					where a sub-processor or our Merchant of Record (Polar, in the United
					States) requires it; that transfer relies on the Standard Contractual
					Clauses adopted by the European Commission, with additional
					safeguards.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Where your data is stored</h2>
				<p className={styles.body}>
					All Hoursmith application data is stored in the EU.
				</p>
				<ul className={styles.bulletList}>
					<li>
						Vercel serverless functions run in the <code>fra1</code> region
						(Frankfurt, Germany).
					</li>
					<li>
						Supabase databases (auth + Postgres) are hosted in{' '}
						<code>eu-central-1</code> (Frankfurt, Germany).
					</li>
					<li>
						Polar (Polar Software Inc.) operates from the United States;
						transfers of your billing data rely on the Standard Contractual
						Clauses. As Merchant of Record, Polar collects and remits EU VAT
						under the One-Stop-Shop (OSS) scheme.
					</li>
				</ul>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>How long we keep it</h2>
				<ul className={styles.bulletList}>
					<li>
						<strong>Account data</strong> is kept while your account exists.
						When you delete your account, your profile row, subscription row,
						and Supabase auth record are removed within 30 days.
					</li>
					<li>
						<strong>Billing records</strong> and invoices are issued and
						retained by Polar, as Merchant of Record, in line with its own legal
						and tax record-keeping obligations. We cannot delete invoices held
						by Polar.
					</li>
					<li>
						<strong>Operational logs</strong> (Vercel) are retained for the
						standard Vercel log-retention window (typically seven days).
					</li>
					<li>
						<strong>Audit log</strong> entries are retained for as long as your
						account exists, plus one year after deletion to allow for fraud
						investigation.
					</li>
				</ul>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Your rights</h2>
				<p className={styles.body}>Under GDPR you have the right to:</p>
				<ul className={styles.bulletList}>
					<li>
						<strong>Access</strong> the personal data we hold about you. Use the
						"Export my data" button on the <code>/account</code> page to
						download a JSON export.
					</li>
					<li>
						<strong>Rectify</strong> inaccurate data by editing your profile or
						by contacting us.
					</li>
					<li>
						<strong>Erase</strong> your data by clicking "Delete my account" on
						the <code>/account</code> page. This is immediate, irreversible, and
						cascades through Polar (cancelling any active subscription) and
						Supabase (removing your auth identity).
					</li>
					<li>
						<strong>Portability:</strong> the same JSON export covers this
						right.
					</li>
					<li>
						<strong>Object</strong> to processing based on legitimate interest.
						Email us to lodge an objection.
					</li>
					<li>
						<strong>Lodge a complaint</strong> with the Portuguese supervisory
						authority (CNPD — Comissão Nacional de Proteção de Dados) or with
						the authority of your habitual residence in the EU.
					</li>
				</ul>
				<p className={styles.body}>
					To exercise any of these rights, contact <code>{CONTACT_EMAIL}</code>.
					We respond within one calendar month.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Security</h2>
				<p className={styles.body}>
					We follow industry-standard practice: TLS everywhere, secrets stored
					in Vercel's encrypted env-var system, principle-of-least-privilege
					keys, row-level security on every Postgres table that holds user data.
					The audit log captures sign-in and account-deletion events to support
					detection of unauthorized access.
				</p>
				<p className={styles.body}>
					If we discover a breach affecting your data we will notify you within
					72 hours of becoming aware of it, in line with Article 33 GDPR.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Children</h2>
				<p className={styles.body}>
					Hoursmith is not directed at children under 16. We do not knowingly
					collect personal data from children. If you believe we hold data about
					a child, contact us and we will delete it.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Changes to this policy</h2>
				<p className={styles.body}>
					We may update this Privacy Policy from time to time. The "Effective
					date" at the top reflects the latest revision. Material changes will
					be communicated to active subscribers by email at least 30 days in
					advance of taking effect.
				</p>
				<p className={styles.body}>
					Historical versions of this policy can be reviewed in the git history
					of this page.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Contact</h2>
				<p className={styles.body}>
					Email <code>{CONTACT_EMAIL}</code>.
				</p>
			</section>

			<hr className={styles.divider} />
			<p className={styles.footer}>
				<strong>Effective date:</strong> {EFFECTIVE_DATE}.
			</p>
		</div>
	);
};
