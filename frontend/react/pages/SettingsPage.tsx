import type React from 'react';
import { useState } from 'react';
import { useConfigStore } from '../../stores/useConfigStore';
import {
	type SettingsIntegrationTests,
	useSettingsFormStore,
} from '../../stores/useSettingsFormStore';
import {
	buildJiraConnectionFingerprint,
	useUIStore,
} from '../../stores/useUIStore';
import { SettingsForm } from '../components/settings/SettingsForm';
import { SettingsReadinessHeader } from '../components/settings/SettingsReadinessHeader';
import { toast } from '../components/ui/Toast';
import { SETTINGS_SECTION_IDS } from '../constants/settingsSections';
import { usePageTitle } from '../hooks/usePageTitle';
import { buildSettingsSetupModel } from '../utils/settingsSetup';
import * as styles from './SettingsPage.module.css';

export const SettingsPage: React.FC = () => {
	usePageTitle('Settings');
	const formData = useSettingsFormStore((state) => state.formData);
	const integrationTests = useSettingsFormStore(
		(state) => state.integrationTests,
	);
	const testJira = useSettingsFormStore((state) => state.testJira);
	const testGitlab = useSettingsFormStore((state) => state.testGitlab);
	const testCalendar = useSettingsFormStore((state) => state.testCalendar);
	const testRescueTime = useSettingsFormStore((state) => state.testRescueTime);
	const savedConfig = useConfigStore((state) => state.config);
	const jiraConnectionEvidenceAt = useUIStore(
		(state) => state.jiraConnectionEvidenceAt,
	);
	const jiraConnectionEvidenceFingerprint = useUIStore(
		(state) => state.jiraConnectionEvidenceFingerprint,
	);
	const [checksRunning, setChecksRunning] = useState(false);
	const [lastDiagnosticsRunAt, setLastDiagnosticsRunAt] = useState<
		string | null
	>(null);
	const [lastDiagnosticsSummary, setLastDiagnosticsSummary] = useState<
		string | null
	>(null);
	const [activeSection, setActiveSection] = useState<string>(
		SETTINGS_SECTION_IDS.connection,
	);
	const [readinessCollapsed, setReadinessCollapsed] = useState(false);

	const isDirty = JSON.stringify(formData) !== JSON.stringify(savedConfig);
	const canTestJira =
		!!formData.jiraHost.trim() &&
		!!formData.email.trim() &&
		!!formData.apiToken.trim();
	const canTestGitlab =
		!!formData.gitlabHost.trim() && !!formData.gitlabToken.trim();
	const canTestRescueTime = !!formData.rescueTimeApiKey.trim();
	const hasCalendarFeeds = (formData.calendarFeeds ?? []).some((feed) =>
		feed.url.trim(),
	);
	const canRunChecks =
		canTestJira || canTestGitlab || hasCalendarFeeds || canTestRescueTime;
	const savedConnectionEvidenceAt =
		jiraConnectionEvidenceFingerprint ===
		buildJiraConnectionFingerprint(savedConfig)
			? jiraConnectionEvidenceAt
			: null;

	const model = buildSettingsSetupModel(
		formData,
		integrationTests,
		isDirty,
		savedConnectionEvidenceAt,
	);

	// Selecting a readiness step/section activates that rail section in the form
	// and scrolls it into view (replaces the old scroll-to-anchor behaviour).
	const selectSection = (sectionId: string) => {
		setActiveSection(sectionId);
		document.getElementById(SETTINGS_SECTION_IDS.form)?.scrollIntoView({
			behavior: 'smooth',
			block: 'start',
		});
	};

	const summarizeDiagnostics = (tests: SettingsIntegrationTests) => {
		const results = [
			canTestJira ? tests.jira.result : null,
			canTestGitlab ? tests.gitlab.result : null,
			hasCalendarFeeds ? tests.calendar.result : null,
			canTestRescueTime ? tests.rescuetime.result : null,
		].filter((result): result is NonNullable<typeof result> => result !== null);

		if (results.length === 0) return null;
		const successCount = results.filter((result) => result.success).length;
		return `${successCount}/${results.length} checks passed`;
	};

	const runAvailableChecks = async () => {
		if (!canRunChecks) {
			toast.error(
				'Add at least a Jira connection or one optional source first',
			);
			return;
		}

		setChecksRunning(true);
		try {
			if (canTestJira) {
				await testJira();
			}
			if (canTestGitlab) {
				await testGitlab();
			}
			if (hasCalendarFeeds) {
				await testCalendar();
			}
			if (canTestRescueTime) {
				await testRescueTime();
			}
			const completedTests = useSettingsFormStore.getState().integrationTests;
			setLastDiagnosticsRunAt(new Date().toLocaleString());
			setLastDiagnosticsSummary(summarizeDiagnostics(completedTests));
			toast.success('Diagnostics refreshed');
		} finally {
			setChecksRunning(false);
		}
	};

	return (
		<div className={styles.container}>
			<SettingsReadinessHeader
				model={model}
				canRunChecks={canRunChecks}
				checksRunning={checksRunning}
				lastRunAt={lastDiagnosticsRunAt}
				lastRunSummary={lastDiagnosticsSummary}
				canCollapse={model.status === 'ready'}
				collapsed={readinessCollapsed}
				onToggleCollapsed={() => setReadinessCollapsed((value) => !value)}
				onSelectSection={selectSection}
				onRunAvailableChecks={runAvailableChecks}
			/>

			<SettingsForm
				setupModel={model}
				activeSection={activeSection}
				onSelectSection={setActiveSection}
			/>
		</div>
	);
};
