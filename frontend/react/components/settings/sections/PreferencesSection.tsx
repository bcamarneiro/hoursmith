import type React from 'react';
import { useEffect } from 'react';
import { useConfigStore } from '../../../../stores/useConfigStore';
import { SETTINGS_SECTION_IDS } from '../../../constants/settingsSections';
import * as styles from '../SettingsForm.module.css';

/**
 * Apply a theme to the document root. Mirrors the shared `useTheme` hook's DOM
 * mechanism (data-theme attribute) so we can offer a live preview from inside
 * Settings without editing the App-owned theme provider (ADA-451).
 */
function applyThemeToDocument(theme: 'system' | 'light' | 'dark'): void {
	if (typeof document === 'undefined') return;
	if (theme === 'light') {
		document.documentElement.setAttribute('data-theme', 'light');
	} else if (theme === 'dark') {
		document.documentElement.setAttribute('data-theme', 'dark');
	} else {
		document.documentElement.removeAttribute('data-theme');
	}
}

type Props = {
	theme: 'system' | 'light' | 'dark';
	timeRounding: 'off' | '15m' | '30m';
	includeAbsenceInCsv: boolean;
	includeCsvProvenance: boolean;
	analyticsOptOut: boolean;
	handleSelectChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
	handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	themeId: string;
	timeRoundingId: string;
	includeAbsenceInCsvId: string;
	includeCsvProvenanceId: string;
	analyticsOptOutId: string;
};

/**
 * Preferences section: theme + time-rounding selects. Local UI state
 * only — does not touch any external service.
 */
export const PreferencesSection: React.FC<Props> = ({
	theme,
	timeRounding,
	includeAbsenceInCsv,
	includeCsvProvenance,
	analyticsOptOut,
	handleSelectChange,
	handleChange,
	themeId,
	timeRoundingId,
	includeAbsenceInCsvId,
	includeCsvProvenanceId,
	analyticsOptOutId,
}) => {
	// ADA-451: apply the selected theme live as the user changes it, instead of
	// only after Save. On unmount (e.g. navigating away without saving) restore
	// the persisted theme so an un-saved preview never sticks. The App-owned
	// `useTheme` hook remains the source of truth for the saved value.
	useEffect(() => {
		applyThemeToDocument(theme);
		return () => {
			applyThemeToDocument(useConfigStore.getState().config.theme);
		};
	}, [theme]);

	return (
		<fieldset id={SETTINGS_SECTION_IDS.preferences} className={styles.section}>
			<legend className={styles.sectionTitle}>Preferences</legend>
			<div className={styles.formGroup}>
				<label htmlFor={themeId}>Theme</label>
				<select
					id={themeId}
					name="theme"
					value={theme}
					onChange={handleSelectChange}
				>
					<option value="system">System</option>
					<option value="light">Light</option>
					<option value="dark">Dark</option>
				</select>
				<small>Choose light, dark, or follow your system preference</small>
			</div>
			<div className={styles.formGroup}>
				<label htmlFor={timeRoundingId}>Time Rounding</label>
				<select
					id={timeRoundingId}
					name="timeRounding"
					value={timeRounding}
					onChange={handleSelectChange}
				>
					<option value="off">Off</option>
					<option value="15m">15 minutes</option>
					<option value="30m">30 minutes</option>
				</select>
				<small>Round suggestion durations to the nearest interval</small>
			</div>
			<div className={styles.formGroup}>
				<label>
					<input
						type="checkbox"
						id={includeAbsenceInCsvId}
						name="includeAbsenceInCsv"
						checked={includeAbsenceInCsv}
						onChange={handleChange}
					/>{' '}
					Include absence columns in CSV exports
				</label>
				<small>
					Adds `IsAbsence`, `AbsenceKind`, and an `AbsenceDays` subtotal so
					finance/HR can reconcile reduced targets. Turn off for byte-stable
					legacy CSVs.
				</small>
			</div>
			<div className={styles.formGroup}>
				<label>
					<input
						type="checkbox"
						id={includeCsvProvenanceId}
						name="includeCsvProvenance"
						checked={includeCsvProvenance}
						onChange={handleChange}
					/>{' '}
					Add a provenance footer to CSV exports
				</label>
				<small>
					Appends a `# generated=… jira=… policy=… period=…` line for
					audit/traceability. Off by default so exports stay clean and don't
					expose the Jira host or build version.
				</small>
			</div>
			<div className={styles.formGroup}>
				<span className={styles.fieldLabel}>Product analytics</span>
				<label>
					<input
						type="checkbox"
						id={analyticsOptOutId}
						name="analyticsOptOut"
						checked={analyticsOptOut}
						onChange={handleChange}
					/>{' '}
					Opt out of anonymous analytics
				</label>
				<small>
					When checked, Hoursmith stops sending anonymous, privacy-preserving
					product analytics. No personal data or Jira content is ever collected.
				</small>
			</div>
		</fieldset>
	);
};
