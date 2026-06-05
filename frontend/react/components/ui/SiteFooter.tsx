import { Link } from 'react-router-dom';
import * as styles from './SiteFooter.module.css';

/**
 * Site-wide footer with the legal + trust links (ADA-367).
 *
 * The legal routes (/privacy, /terms, /sub-processors) existed but nothing
 * linked to them except a single sub-processors link on Pricing — missing
 * Privacy/Terms/contact links are a trust + EU/Polar-MoR compliance gap at
 * launch (and hurt SEO crawl). Rendered globally, in normal flow, separate
 * from the fixed-corner BuildInfoFooter version chip.
 */

// TODO(ADA-283): replace once support@hoursmith.io is provisioned.
const CONTACT_EMAIL = 'privacy@hoursmith.io';
const GITHUB_URL = 'https://github.com/bcamarneiro/hoursmith';

export function SiteFooter(): JSX.Element {
	return (
		<footer className={styles.footer}>
			<nav className={styles.links} aria-label="Footer">
				<Link to="/privacy" className={styles.link}>
					Privacy
				</Link>
				<Link to="/terms" className={styles.link}>
					Terms
				</Link>
				<Link to="/sub-processors" className={styles.link}>
					Sub-processors
				</Link>
				<a className={styles.link} href={`mailto:${CONTACT_EMAIL}`}>
					Contact
				</a>
				<a
					className={styles.link}
					href={GITHUB_URL}
					target="_blank"
					rel="noreferrer noopener"
				>
					GitHub
				</a>
			</nav>
			<p className={styles.legal}>© Hoursmith — a Jira worklog dashboard.</p>
		</footer>
	);
}
