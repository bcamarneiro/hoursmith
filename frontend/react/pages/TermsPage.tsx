import type React from 'react';
import { LEAD_TIER_ENABLED } from '../../featureFlags';
import { usePageTitle } from '../hooks/usePageTitle';
import * as styles from './LegalPage.module.css';

/**
 * Public Terms of Service page. Mirrors `docs/terms.md`.
 *
 * Same sync trade-off as PrivacyPage / SubProcessorsPage: hand-translated
 * markdown for styling consistency and zero new deps. Update both files when
 * material terms change.
 */

const EFFECTIVE_DATE = '2026-05-27';
// TODO(ADA-283): replace once support@hoursmith.io is provisioned.
const CONTACT_EMAIL = 'privacy@hoursmith.io';

export const TermsPage: React.FC = () => {
	usePageTitle('Terms of Service');
	return (
		<div className={styles.page}>
			<header className={styles.hero}>
				<h1 className={styles.title}>Terms of Service</h1>
				<p className={styles.meta}>Effective date: {EFFECTIVE_DATE}.</p>
				<p className={styles.lede}>
					These Terms of Service govern your use of the hosted Hoursmith service
					at hoursmith.io. The open-source code that powers Hoursmith is
					separately governed by the MIT License (Free tier) and the BSL 1.1
					License (Premium tier) in the project repository.
				</p>
				<p className={styles.body}>
					The service is operated by <strong>Future Sketches</strong>,
					established in <strong>Portugal</strong>. By creating an account or
					using the service you agree to these Terms. If you do not agree, do
					not use the service.
				</p>
			</header>

			<section className={styles.section}>
				<h2 className={styles.heading}>What Hoursmith does</h2>
				<p className={styles.body}>
					Hoursmith is a Jira worklog dashboard. The Free tier is provided as a
					static web application; you bring your own Jira credentials and your
					own CORS proxy. The Premium tier is a paid annual subscription that
					adds a hosted CORS proxy and convenience features.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Your account</h2>
				<p className={styles.body}>
					You must be at least 16 years old to use Hoursmith. You agree to
					provide a valid email address and to keep your account credentials
					confidential. You may delete your account at any time from the{' '}
					<code>/account</code> page.
				</p>
				<p className={styles.body}>
					You are responsible for the Jira credentials you provide to the
					application. Your Jira API token is stored in your browser; we never
					see it. If your Jira workspace is compromised that is not within our
					control.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Subscriptions and billing</h2>
				<p className={styles.body}>
					Premium is sold through <strong>Polar</strong> (Polar Software Inc.),
					which acts as the <strong>Merchant of Record</strong> and seller of
					record for your subscription. Premium is a{' '}
					<strong>fixed-price annual subscription</strong>: the Hosted tier is{' '}
					<strong>€29/year</strong> (with a founding rate of{' '}
					<strong>€19/year</strong> for early subscribers, kept for as long as
					the subscription stays active)
					{LEAD_TIER_ENABLED ? (
						<>
							, and the Lead tier is <strong>€60/year</strong>, rising to{' '}
							<strong>€120/year</strong> as further Lead features ship
						</>
					) : null}
					. The subscription renews automatically each year at your
					subscription's price, unless you cancel.
				</p>
				<p className={styles.body}>
					<strong>14-day right of withdrawal (EU):</strong> Under the EU
					Consumer Rights Directive you have 14 days from the date of
					subscription to withdraw and receive a full refund. Email us to
					exercise this right. After 14 days, payments are non-refundable except
					where required by law.
				</p>
				<p className={styles.body}>
					<strong>Cancellation:</strong> You can cancel at any time from the
					Polar customer portal linked from <code>/account</code>. Cancellation
					takes effect at the end of the current billing period; the service
					remains available until then. You will not be charged again.
				</p>
				<p className={styles.body}>
					<strong>Failed payments:</strong> If a renewal payment fails we will
					attempt to charge again over the following days. If the payment
					ultimately fails the subscription will be downgraded to Free and the
					hosted CORS proxy will stop working for your account. Your saved
					configuration (which lives in your browser) is unaffected.
				</p>
				<p className={styles.body}>
					<strong>Taxes:</strong> Prices are shown exclusive of VAT; applicable
					VAT is added at checkout. As Merchant of Record, Polar is the seller
					of record and is responsible for calculating, collecting, and
					remitting VAT for EU customers based on your billing address. If you
					supply a valid VAT ID at checkout the reverse-charge mechanism applies
					where eligible.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Acceptable use</h2>
				<p className={styles.body}>You agree not to:</p>
				<ul className={styles.bulletList}>
					<li>
						Use the hosted CORS proxy to send traffic to Jira instances you are
						not authorized to access.
					</li>
					<li>
						Use the service to send abusive, unlawful, or infringing content.
					</li>
					<li>Attempt to reverse-engineer, scrape, or overload the service.</li>
					<li>Resell or sublicense the hosted service to third parties.</li>
				</ul>
				<p className={styles.body}>
					We may suspend or terminate accounts that violate these rules. If we
					suspend your account for cause we will not refund the unused portion
					of your subscription.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Open source</h2>
				<p className={styles.body}>
					The application code is published in the public repository. The Free
					tier is licensed under MIT. The Premium tier code (the{' '}
					<code>/premium</code> directory) is licensed under BSL 1.1 with a
					change date of 2030-05-16, after which it converts to Apache 2.0. You
					may read, fork, and self-host the code under those licenses.
				</p>
				<p className={styles.body}>
					Use of the hosted service at hoursmith.io is governed by these Terms
					regardless of the underlying source licenses.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Service availability</h2>
				<p className={styles.body}>
					We aim for high availability but the service is provided "as is"
					without a formal uptime SLA. Planned maintenance windows will be
					communicated in advance to active subscribers where reasonably
					possible.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Disclaimer of warranties</h2>
				<p className={styles.body}>
					THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES
					OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTY OF
					MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR
					NON-INFRINGEMENT. We do not warrant that the service will be
					uninterrupted, error-free, or secure against all forms of intrusion.
					Nothing in these Terms excludes or limits any liability that cannot be
					excluded or limited under applicable consumer-protection law.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Limitation of liability</h2>
				<p className={styles.body}>
					To the maximum extent permitted by law, our aggregate liability to you
					for any claim arising out of or relating to these Terms or the service
					is limited to the amount you paid for the service in the 12 months
					preceding the event giving rise to the claim. We are not liable for
					indirect, incidental, consequential, or punitive damages, or for loss
					of profits, revenue, data, or goodwill.
				</p>
				<p className={styles.body}>
					Nothing in this section limits liability for fraud, gross negligence,
					death or personal injury caused by our negligence, or any other
					liability that cannot be limited under applicable law.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Indemnity</h2>
				<p className={styles.body}>
					You agree to indemnify and hold us harmless from any claim brought by
					a third party arising out of (a) your violation of these Terms, (b)
					your violation of any law or third-party right, or (c) content you
					submitted through the service.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Termination</h2>
				<p className={styles.body}>
					You may terminate your account at any time as described under
					"Cancellation". We may terminate or suspend your access if you
					materially breach these Terms; we will give you notice and a
					reasonable opportunity to cure where the nature of the breach allows.
				</p>
				<p className={styles.body}>
					On termination, your account data is deleted on the schedule described
					in the <a href="/privacy">Privacy Policy</a>.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Changes to the service</h2>
				<p className={styles.body}>
					Hoursmith is actively developed. We may add, modify, or remove
					features. We will not materially reduce the functionality of the
					Premium tier within a paid period; if we do, you may cancel and
					receive a pro-rated refund for the unused portion.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Changes to these Terms</h2>
				<p className={styles.body}>
					We may update these Terms from time to time. The "Effective date" at
					the top reflects the latest revision. Material changes will be
					communicated to active subscribers by email at least 30 days in
					advance of taking effect. Continued use of the service after the
					effective date constitutes acceptance.
				</p>
			</section>

			<section className={styles.section}>
				<h2 className={styles.heading}>Governing law and disputes</h2>
				<p className={styles.body}>
					These Terms are governed by the laws of <strong>Portugal</strong>,
					without regard to its conflict-of-laws rules. Disputes will be
					resolved in the courts of Lisbon, Portugal, unless mandatory
					consumer-protection law gives you the right to bring proceedings in
					another forum (typically the courts of your habitual residence in the
					EU).
				</p>
				<p className={styles.body}>
					Nothing in these Terms affects your statutory rights as a consumer.
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
