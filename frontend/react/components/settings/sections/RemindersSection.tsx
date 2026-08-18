import type React from 'react';
import { useEffect, useId, useState } from 'react';
import { trackEvent } from '../../../../analytics';
import { getProxyOverrideState } from '../../../../services/proxyUrlBridge';
import {
	fetchReminderSettings,
	postReminderState,
	type ReminderLocalSettings,
} from '../../../../services/reminderSync';
import { SETTINGS_SECTION_IDS } from '../../../constants/settingsSections';
import { toast } from '../../ui/Toast';
import * as styles from '../SettingsForm.module.css';
import * as local from './RemindersSection.module.css';

const DEFAULTS: ReminderLocalSettings = {
	enabled: false,
	memberNudge: true,
	leadDigest: true,
	leadEmail: '',
	teamName: '',
};

/**
 * Reminders section (ADA-552) — the lead opts in to automated chasing: the
 * server nudges members who are behind and/or sends the lead a "who's behind"
 * digest. Hosted-tier only; gated at the form level by build tier + the
 * `reminders-ui` flag, so this component assumes it should render.
 *
 * Self-contained: reminder settings live server-side (source of truth), so this
 * hydrates from `/api/reminders/state` and saves back there directly, rather
 * than threading through the parity-locked main settings form. The Supabase
 * access token comes from the cross-tier proxy bridge — no premium import, so
 * the Free bundle still builds.
 */
export const RemindersSection: React.FC = () => {
	const [settings, setSettings] = useState<ReminderLocalSettings>(DEFAULTS);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const leadEmailId = useId();

	const token = getProxyOverrideState().supabaseAccessToken;

	useEffect(() => {
		let cancelled = false;
		if (!token) {
			setLoading(false);
			return;
		}
		void fetchReminderSettings(token).then((saved) => {
			if (cancelled) return;
			if (saved) setSettings({ ...DEFAULTS, ...saved });
			setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [token]);

	const set = <K extends keyof ReminderLocalSettings>(
		key: K,
		value: ReminderLocalSettings[K],
	) => setSettings((prev) => ({ ...prev, [key]: value }));

	const onSave = async () => {
		if (!token) return;
		setSaving(true);
		const result = await postReminderState(token, { settings });
		setSaving(false);
		if (result.ok) {
			trackEvent('reminders_settings_saved', { enabled: settings.enabled });
			toast.success('Reminder settings saved.');
		} else {
			toast.error(
				result.error === 'subscription_required'
					? 'Reminders are a Hosted-plan feature.'
					: 'Could not save reminder settings. Please try again.',
			);
		}
	};

	return (
		<fieldset id={SETTINGS_SECTION_IDS.reminders} className={styles.section}>
			<legend className={styles.sectionTitle}>Reminders</legend>
			<small className={local.intro}>
				Let Hoursmith chase incomplete timesheets for you. Nobody on leave is
				ever nudged, and reminders measure whether hours are logged on time —
				not productivity.
			</small>

			{!token ? (
				<p className={local.signedOut}>
					Sign in to your Hosted account to configure reminders.
				</p>
			) : (
				<>
					<label className={styles.checkboxLabel}>
						<input
							type="checkbox"
							checked={settings.enabled}
							disabled={loading}
							onChange={(e) => set('enabled', e.target.checked)}
						/>
						Enable reminders for my team
					</label>

					<div
						className={local.subToggles}
						aria-disabled={!settings.enabled}
						hidden={!settings.enabled}
					>
						<label className={styles.checkboxLabel}>
							<input
								type="checkbox"
								checked={settings.memberNudge}
								onChange={(e) => set('memberNudge', e.target.checked)}
							/>
							Nudge each member who is behind
						</label>
						<label className={styles.checkboxLabel}>
							<input
								type="checkbox"
								checked={settings.leadDigest}
								onChange={(e) => set('leadDigest', e.target.checked)}
							/>
							Send me a weekly "who's behind" digest
						</label>
						<label className={local.field} htmlFor={leadEmailId}>
							Digest email
							<input
								id={leadEmailId}
								type="email"
								placeholder="you@company.com"
								value={settings.leadEmail ?? ''}
								onChange={(e) => set('leadEmail', e.target.value)}
							/>
						</label>
					</div>

					<button
						type="button"
						className={local.save}
						onClick={onSave}
						disabled={loading || saving}
					>
						{saving ? 'Saving…' : 'Save reminder settings'}
					</button>
				</>
			)}
		</fieldset>
	);
};
