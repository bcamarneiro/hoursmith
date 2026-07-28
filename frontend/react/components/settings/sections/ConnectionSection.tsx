import type React from 'react';
import { useEffect, useState } from 'react';
import { SETTINGS_SECTION_IDS } from '../../../constants/settingsSections';
import { useProxyBadge } from '../../../hooks/useProxyBadge';
import { PremiumWaitlistForm } from '../../marketing/PremiumWaitlistForm';
import * as styles from '../SettingsForm.module.css';

// The connection-test failure copy that means "the network blocked direct
// access" (ADA-484 #4). When we see it, auto-open the Advanced proxy disclosure
// so the "set up a proxy below" guidance actually reveals the field.
const NETWORK_BLOCK_PATTERN =
	/blocking direct browser access|network is blocking/i;

interface IntegrationTestResult {
	loading: boolean;
	result: { success: boolean; message: string } | null;
}

type Props = {
	formData: {
		jiraHost: string;
		email: string;
		apiToken: string;
		corsProxy: string;
	};
	handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	testJira: () => void;
	canTestJira: boolean;
	integrationTest: IntegrationTestResult;
	jiraHostId: string;
	emailId: string;
	apiTokenId: string;
	corsProxyId: string;
};

/**
 * Connection section: Jira host, email, API token, optional CORS proxy.
 * Owns its own "Test connection" button and the integration test result
 * banner. State and update callbacks come from the parent SettingsForm
 * so this component stays a pure renderer.
 */
export const ConnectionSection: React.FC<Props> = ({
	formData,
	handleChange,
	testJira,
	canTestJira,
	integrationTest,
	jiraHostId,
	emailId,
	apiTokenId,
	corsProxyId,
}) => {
	// ADA-446: API token renders masked by default with a reveal/hide toggle.
	const [showApiToken, setShowApiToken] = useState(false);
	// ADA-273: when the user is signed in with an active Premium subscription
	// we auto-route through the hosted CORS proxy. The badge + override link
	// below makes this visible and keeps an escape hatch.
	const proxyBadge = useProxyBadge();
	const hostedActive = proxyBadge.mode === 'hosted';

	// ADA-484 #1: on first run the proxy / network block (the `npm run cors-proxy`
	// + SOCKS5 jargon) is hidden behind an "Advanced" disclosure, so a
	// non-technical lead sees only host / email / token. It opens by default only
	// when it's actually relevant: a proxy is already configured, the user can
	// manage the hosted proxy (Premium), or the last connection test failed
	// because the network blocked direct access.
	const lastTestBlockedAccess =
		!!integrationTest.result &&
		!integrationTest.result.success &&
		NETWORK_BLOCK_PATTERN.test(integrationTest.result.message);
	const advancedRelevant =
		formData.corsProxy.trim().length > 0 ||
		proxyBadge.canOverride ||
		lastTestBlockedAccess;
	const [advancedOpen, setAdvancedOpen] = useState(advancedRelevant);
	// A network-block failure can arrive after mount (the user clicks Test), so
	// reveal the proxy field when it does — matching the error copy's "below".
	useEffect(() => {
		if (lastTestBlockedAccess) setAdvancedOpen(true);
	}, [lastTestBlockedAccess]);

	return (
		<fieldset id={SETTINGS_SECTION_IDS.connection} className={styles.section}>
			<legend className={styles.sectionTitle}>
				<div className={styles.sectionHeader}>
					<span>Connection</span>
					<button
						type="button"
						className={styles.testButton}
						onClick={testJira}
						disabled={integrationTest.loading || !canTestJira}
					>
						{integrationTest.loading ? 'Testing...' : 'Test'}
					</button>
				</div>
			</legend>
			{integrationTest.result && (
				<p
					className={`${styles.testResult} ${integrationTest.result.success ? styles.testSuccess : styles.testError}`}
					role="status"
					aria-live="polite"
				>
					{integrationTest.result.success ? '✓ Success: ' : '✗ Error: '}
					{integrationTest.result.message}
				</p>
			)}
			<div className={styles.formGroup}>
				<label htmlFor={jiraHostId}>Jira Host</label>
				<input
					type="text"
					id={jiraHostId}
					name="jiraHost"
					value={formData.jiraHost}
					onChange={handleChange}
					placeholder="your-company.atlassian.net"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					required
				/>
				<small>
					The domain you see in Jira, like{' '}
					<code>your-company.atlassian.net</code>.
				</small>
				<small>
					Hostname only is ideal, but pasted <code>https://</code> URLs are
					normalized for you
				</small>
			</div>
			<div className={styles.formGroup}>
				<label htmlFor={emailId}>Email</label>
				<input
					type="email"
					id={emailId}
					name="email"
					value={formData.email}
					onChange={handleChange}
					placeholder="your-email@example.com"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					required
				/>
			</div>
			<div className={styles.formGroup}>
				<label htmlFor={apiTokenId}>API Token</label>
				<div className={styles.secretInputRow}>
					<input
						type={showApiToken ? 'text' : 'password'}
						id={apiTokenId}
						name="apiToken"
						value={formData.apiToken}
						onChange={handleChange}
						autoComplete="off"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						required
					/>
					<button
						type="button"
						className={styles.revealButton}
						onClick={() => setShowApiToken((value) => !value)}
						aria-pressed={showApiToken}
						aria-controls={apiTokenId}
						aria-label={showApiToken ? 'Hide API token' : 'Show API token'}
						title={showApiToken ? 'Hide API token' : 'Show API token'}
					>
						{showApiToken ? 'Hide' : 'Show'}
					</button>
				</div>
				<details className={styles.tokenHelp}>
					<summary>How do I get an API token?</summary>
					<ol className={styles.tokenSteps}>
						<li>
							Open the{' '}
							<a
								href="https://id.atlassian.com/manage-profile/security/api-tokens"
								target="_blank"
								rel="noopener noreferrer"
							>
								Atlassian API tokens page
							</a>{' '}
							(opens in a new tab).
						</li>
						<li>
							Click <strong>Create API token</strong>, give it a label like{' '}
							<code>Hoursmith</code>, and copy the value it shows you.
						</li>
						<li>
							Paste it into the <strong>API Token</strong> field above. It stays
							in this browser — Hoursmith never sees or stores it.
						</li>
					</ol>
				</details>
			</div>
			<details
				className={styles.advanced}
				open={advancedOpen}
				onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
			>
				<summary className={styles.advancedSummary}>
					Advanced — proxy &amp; network{' '}
					<span className={styles.optional}>optional</span>
				</summary>
				<p className={styles.advancedHint}>
					Most people can leave this alone. Only needed if your browser or
					network blocks direct access to Jira.
				</p>
				<div className={styles.formGroup}>
					<label htmlFor={corsProxyId}>
						CORS Proxy <span className={styles.optional}>optional</span>
						{hostedActive ? (
							<span
								className={styles.badgePremium}
								title="Your Jira token never leaves your browser — the hosted proxy just forwards the request to Atlassian."
							>
								Hosted by Premium
							</span>
						) : proxyBadge.canOverride && proxyBadge.userOverride ? (
							<span className={styles.badgeNeutral}>
								Self-hosted (overridden)
							</span>
						) : formData.corsProxy.trim() ? (
							<span className={styles.badgeNeutral}>Self-hosted</span>
						) : null}
					</label>
					<input
						type="text"
						id={corsProxyId}
						name="corsProxy"
						value={
							hostedActive ? (proxyBadge.hostedUrl ?? '') : formData.corsProxy
						}
						onChange={handleChange}
						placeholder="http://localhost:8081"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						disabled={hostedActive}
						readOnly={hostedActive}
					/>
					{proxyBadge.canOverride ? (
						<small>
							{hostedActive
								? 'You are subscribed to Premium — Jira requests are being routed through the Hoursmith hosted proxy.'
								: 'You overrode the hosted proxy. Your self-configured value above is being used.'}{' '}
							<button
								type="button"
								className={styles.linkButton}
								onClick={() =>
									proxyBadge.setUserOverride(!proxyBadge.userOverride)
								}
							>
								{hostedActive ? 'Override' : 'Use hosted proxy'}
							</button>
						</small>
					) : (
						<>
							<small>
								Leave this blank on the first attempt. Only fill it in if the
								Jira check fails because your browser or network blocks direct
								access.
							</small>
							<small>
								Start with <code>npm run cors-proxy</code>. If your environment
								needs SOCKS5, run <code>npm run cors-proxy:socks</code> and keep
								the same local proxy URL here.
							</small>
							{formData.corsProxy.trim() ? (
								<small>
									Jira requests are currently going through{' '}
									<code>{formData.corsProxy.trim()}</code> instead of using
									direct browser access.
								</small>
							) : null}
						</>
					)}
				</div>
				{!proxyBadge.canOverride && (
					<div className={styles.formGroup}>
						<PremiumWaitlistForm
							source="in-app-settings"
							heading="Tired of running the local proxy? Premium hosted-proxy coming soon — leave your email."
						/>
					</div>
				)}
			</details>
		</fieldset>
	);
};
