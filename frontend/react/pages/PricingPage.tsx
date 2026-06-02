import type React from 'react';
import { Link } from 'react-router-dom';
import type { PublicFlags } from '../../services/flagsService';
import { PremiumWaitlistForm } from '../components/marketing/PremiumWaitlistForm';
import { useFlags } from '../hooks/useFlags';
import { usePageTitle } from '../hooks/usePageTitle';
import * as styles from './PricingPage.module.css';

/**
 * Public pricing page. Lives in the Free-tier app shell (everyone sees it).
 *
 * Linear: ADA-304 (this rebuild) + ADA-301 (CTA honesty).
 *
 * Pricing model (confirmed 2026-05-25): three fixed-price annual tiers —
 * Free €0, Hosted €29/yr (founding €19), Lead €60/yr founding → €120/yr public.
 * No name-your-price, no slider, no custom amount. Polar is the Merchant of
 * Record; the actual checkout flow lives at /account → Polar (the page CTAs
 * route there via ?upgrade=<tier> so the checkout flow has one home).
 */

// Shared feature list — same product on every tier. Only proxy/support diverges.
const SHARED_FEATURES = [
	'Personal weekly dashboard',
	'Team and monthly reports',
	'CSV and JSON exports',
	'Calendar feeds, absence tracking, holidays',
	'GitLab and RescueTime suggestions',
	'Local-only credentials',
];

const HOSTED_FEATURES = [
	'Hosted CORS proxy (no local setup)',
	'Priority email support',
];

const LEAD_V1_FEATURES = [
	'Multi-client configuration',
	'Per-client CSV format profiles',
	'Holiday + PTO awareness',
	'Per-client billable rate annotation',
];

const LEAD_V2_ROADMAP = [
	'Scheduled CSV exports',
	'Manager Friday digest',
	'Audit log',
	'Project budget tracking',
];

const TRUST_LINE = 'Cancel anytime · EU VAT handled · Powered by Polar';

/**
 * Paid-tier CTA, gated by the operational flags (ADA-341):
 *   - checkout disabled → an inline "temporarily unavailable" note
 *   - paywall not open for me → the waitlist embed ("Coming soon")
 *   - open → the real checkout CTA (routes to /account → Polar)
 */
const PaidCta: React.FC<{
	flags: PublicFlags;
	href: string;
	label: string;
}> = ({ flags, href, label }) => {
	if (!flags.checkoutEnabled) {
		return (
			<p className={styles.trustLine}>Checkout is temporarily unavailable.</p>
		);
	}
	if (!flags.paywallOpenForMe) {
		return <PremiumWaitlistForm source="pricing" />;
	}
	return (
		<>
			<a href={href} className={styles.primaryCta}>
				{label}
			</a>
			<p className={styles.trustLine}>{TRUST_LINE}</p>
		</>
	);
};

export const PricingPage: React.FC = () => {
	usePageTitle('Pricing');
	const flags = useFlags();

	return (
		<div className={styles.page}>
			<header className={styles.hero}>
				<h1 className={styles.title}>Pricing.</h1>
				<p className={styles.timeCost}>
					Hoursmith replaces ~2 hours of month-end timesheet chasing per client.
					Worth €29 — or €60 if you serve multiple clients.
				</p>
			</header>

			<section className={styles.tiers}>
				{/* Free */}
				<article className={styles.tier}>
					<header className={styles.tierHeader}>
						<h2 className={styles.tierName}>Free</h2>
						<p className={styles.tierPrice}>
							<span className={styles.priceAmount}>€0</span>
							<span className={styles.priceCadence}>forever</span>
						</p>
						<p className={styles.tierTagline}>
							For solo devs and self-hosters. Bring your own Jira credentials
							and your own CORS proxy. Full app, MIT-licensed. Run{' '}
							<code>npm run cors-proxy</code> and you're set.
						</p>
					</header>
					<ul className={styles.featureList}>
						{SHARED_FEATURES.map((feature) => (
							<li key={feature} className={styles.featureItem}>
								{feature}
							</li>
						))}
						<li className={styles.featureItem}>Self-hosted CORS proxy</li>
						<li className={styles.featureItem}>Community support</li>
					</ul>
					<div className={styles.ctaSlot}>
						<Link to="/settings" className={styles.secondaryCta}>
							Get started
						</Link>
					</div>
				</article>

				{/* Hosted */}
				<article className={`${styles.tier} ${styles.tierFeatured}`}>
					<header className={styles.tierHeader}>
						<h2 className={styles.tierName}>Hosted</h2>
						<p className={styles.tierPrice}>
							<span className={styles.priceAmount}>€29</span>
							<span className={styles.priceCadence}>/year</span>
						</p>
						<p className={styles.foundingNote}>
							Founding rate <strong>€19/year</strong> for early subscribers
							(locked for as long as you stay subscribed).
						</p>
						<p className={styles.tierHeadline}>
							Stop running CORS proxies on your laptop.
						</p>
						<p className={styles.tierTagline}>
							For individual team leads. Everything in Free, plus a hosted CORS
							proxy and priority email support.
						</p>
					</header>
					<ul className={styles.featureList}>
						{SHARED_FEATURES.map((feature) => (
							<li key={feature} className={styles.featureItem}>
								{feature}
							</li>
						))}
						{HOSTED_FEATURES.map((feature) => (
							<li key={feature} className={styles.featureItem}>
								<strong>{feature}</strong>
							</li>
						))}
					</ul>
					<div className={styles.ctaSlot}>
						<PaidCta
							flags={flags}
							href="/account?upgrade=hosted"
							label="Get Hosted — €29/year"
						/>
					</div>
				</article>

				{/* Lead */}
				<article className={styles.tier}>
					<header className={styles.tierHeader}>
						<h2 className={styles.tierName}>Lead</h2>
						<p className={styles.tierPrice}>
							<span className={styles.priceAmount}>€60</span>
							<span className={styles.priceCadence}>/year (founding)</span>
						</p>
						<p className={styles.foundingNote}>
							Public price rises to <strong>€120/year</strong> as V2 ships.
							Founding subscribers keep €60.
						</p>
						<p className={styles.tierHeadline}>
							Configure each client once. Switch in two clicks.
						</p>
						<p className={styles.tierTagline}>
							For team leads invoicing multiple clients. Everything in Hosted,
							plus the client-aware workflow.
						</p>
					</header>
					<ul className={styles.featureList}>
						{LEAD_V1_FEATURES.map((feature) => (
							<li key={feature} className={styles.featureItem}>
								<strong>{feature}</strong>
							</li>
						))}
					</ul>
					<p className={styles.roadmapHeading}>Coming to Lead in 2026:</p>
					<ul className={styles.roadmapList}>
						{LEAD_V2_ROADMAP.map((feature) => (
							<li key={feature} className={styles.roadmapItem}>
								{feature}
							</li>
						))}
					</ul>
					<div className={styles.ctaSlot}>
						<PaidCta
							flags={flags}
							href="/account?upgrade=lead"
							label="Get Lead — €60/year (founding)"
						/>
					</div>
				</article>
			</section>

			<section
				className={styles.policy}
				aria-labelledby="founding-policy-heading"
			>
				<h2 id="founding-policy-heading" className={styles.policyHeading}>
					Founding-customer rate
				</h2>
				<p className={styles.policyBody}>
					Subscribe at <strong>€60</strong> before the V2 features ship, and
					your price stays €60/year while you stay subscribed. As we add
					scheduled exports, manager digests, audit log, and project budget
					tracking later in 2026, public pricing rises to{' '}
					<strong>€120/year</strong>. Yours doesn't.
				</p>
				<p className={styles.policyBody}>
					The same lock applies to Hosted founding subscribers:{' '}
					<strong>€19 stays €19</strong> even after the public price returns to
					€29.
				</p>
			</section>

			<section className={styles.faq} aria-labelledby="pricing-faq-heading">
				<h2 id="pricing-faq-heading" className={styles.faqHeading}>
					Questions
				</h2>
				<dl className={styles.faqList}>
					<div className={styles.faqItem}>
						<dt className={styles.faqQuestion}>
							What's the difference between Hosted and Lead?
						</dt>
						<dd className={styles.faqAnswer}>
							Hosted gives you the hosted CORS proxy so you don't run anything
							locally. Lead adds the multi-client workflow (per-client CSV
							profiles, billable rates, PTO awareness) for people who invoice
							two or more clients.
						</dd>
					</div>
					<div className={styles.faqItem}>
						<dt className={styles.faqQuestion}>Why pay if it's open source?</dt>
						<dd className={styles.faqAnswer}>
							Convenience. The hosted proxy means there's no terminal step and
							it works on every device. Paying also keeps the open-source app
							moving forward.
						</dd>
					</div>
					<div className={styles.faqItem}>
						<dt className={styles.faqQuestion}>Where is my data?</dt>
						<dd className={styles.faqAnswer}>
							Your Jira token stays in your browser. The hosted proxy passes
							requests through to Jira without persisting anything. See the full{' '}
							<Link to="/sub-processors" className={styles.inlineLink}>
								sub-processors list
							</Link>
							.
						</dd>
					</div>
					<div className={styles.faqItem}>
						<dt className={styles.faqQuestion}>Can I self-host the proxy?</dt>
						<dd className={styles.faqAnswer}>
							Yes — free forever. Run <code>npm run cors-proxy</code> locally
							and point Settings at it. The Free tier is the full app.
						</dd>
					</div>
					<div className={styles.faqItem}>
						<dt className={styles.faqQuestion}>
							Annual only? What about monthly?
						</dt>
						<dd className={styles.faqAnswer}>
							Annual only. Monthly subscriptions account for ~85% of churn
							events on indie SaaS; annual billing is cleaner for both sides and
							keeps the price genuinely low.
						</dd>
					</div>
				</dl>
			</section>

			<section className={styles.license} aria-labelledby="license-heading">
				<h2 id="license-heading" className={styles.licenseHeading}>
					Source-available, MIT at the core
				</h2>
				<p className={styles.licenseBody}>
					The app is MIT-licensed — fork it, run it, ship it commercially. The
					hosted CORS proxy is under BSL 1.1 to sustain the hosted business; it
					converts to Apache 2.0 in 2030. Self-host the whole stack today via
					the README.
				</p>
			</section>

			<footer className={styles.footer}>
				<Link to="/sub-processors" className={styles.footerLink}>
					Sub-processors and data handling
				</Link>
			</footer>
		</div>
	);
};
