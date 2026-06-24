import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
	AbsenceAssignment,
	CalendarFeed,
} from '../../../stores/useConfigStore';
import {
	createDefaultConfig,
	useConfigStore,
} from '../../../stores/useConfigStore';
import { useSettingsFormStore } from '../../../stores/useSettingsFormStore';
import { useUserDataStore } from '../../../stores/useUserDataStore';
import {
	SETTINGS_RAIL_ITEMS,
	SETTINGS_SECTION_IDS,
} from '../../constants/settingsSections';
import { downloadAsFile } from '../../utils/downloadFile';
import { splitCsvEmailList, uniqueEmailEntries } from '../../utils/emailList';
import {
	createSettingsBackup,
	createSettingsSharePack,
	parseSettingsBackup,
} from '../../utils/settingsBackup';
import type {
	SettingsSetupModel,
	SetupStatus,
} from '../../utils/settingsSetup';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import * as styles from './SettingsForm.module.css';
import { ConnectionSection } from './sections/ConnectionSection';
import { IntegrationsSection } from './sections/IntegrationsSection';
import { PermissionsSection } from './sections/PermissionsSection';
import { PreferencesSection } from './sections/PreferencesSection';
import { ScopeSection } from './sections/ScopeSection';

type FeedEntry = {
	feed: CalendarFeed;
	index: number;
};

type ServiceStatus = {
	tone: 'ready' | 'warning' | 'pending';
	label: string;
};

function getServiceStatus(
	configured: boolean,
	loading: boolean,
	result: { success: boolean; message: string } | null,
): ServiceStatus {
	if (!configured) {
		return { tone: 'pending', label: 'Not configured' };
	}
	if (loading) {
		return { tone: 'warning', label: 'Testing' };
	}
	if (result?.success) {
		return { tone: 'ready', label: 'Ready' };
	}
	if (result?.success === false) {
		return { tone: 'warning', label: 'Needs review' };
	}
	return { tone: 'warning', label: 'Needs review' };
}

function buildFeedEntries(
	feeds: CalendarFeed[] | undefined,
	type: CalendarFeed['type'],
): FeedEntry[] {
	return (feeds ?? [])
		.map((feed, index) => ({ feed, index }))
		.filter((entry) => entry.feed.type === type);
}

function getGitlabTroubleshooting(message: string | null): string | null {
	if (!message) return null;
	const normalized = message.toLowerCase();
	if (
		normalized.includes('rejected the token') ||
		normalized.includes('invalid gitlab token')
	) {
		return 'This usually means the host was reached but the token was rejected. Check that the token belongs to this GitLab instance and still has read_user or api scope.';
	}
	if (normalized.includes('denied access')) {
		return 'GitLab understood the token but blocked the request. Confirm the account can access this instance and the PAT has enough scope.';
	}
	if (normalized.includes('api was not found')) {
		return 'The hostname looks reachable, but the standard GitLab API path was not found. Double-check the host or whether this self-hosted instance needs a custom base path.';
	}
	if (normalized.includes('could not reach')) {
		return 'This is usually a networking, certificate, VPN, or CORS-proxy issue rather than a bad token.';
	}
	return null;
}

type SettingsFormProps = {
	/**
	 * The setup model (from buildSettingsSetupModel) — used only to drive the
	 * rail status dots. Optional so the form still renders standalone in tests.
	 */
	setupModel?: SettingsSetupModel;
	/**
	 * Controlled active rail section. Optional: when omitted the form manages its
	 * own active-section state (keeps the component usable standalone in tests).
	 */
	activeSection?: string;
	onSelectSection?: (sectionId: string) => void;
};

/** Resolve a rail item's status dot from the shared setup model. */
function railStatus(
	model: SettingsSetupModel | undefined,
	setupKey: string | undefined,
): SetupStatus | null {
	if (!model || !setupKey) return null;
	const step = model.steps.find((s) => s.id === setupKey);
	if (step) return step.status;
	const diag = model.diagnostics.find((d) => d.id === setupKey);
	return diag ? diag.status : null;
}

export const SettingsForm: React.FC<SettingsFormProps> = ({
	setupModel,
	activeSection: controlledActiveSection,
	onSelectSection,
}) => {
	const formData = useSettingsFormStore((state) => state.formData);
	const integrationTests = useSettingsFormStore(
		(state) => state.integrationTests,
	);
	const savedConfig = useConfigStore((state) => state.config);
	const updateFormField = useSettingsFormStore(
		(state) => state.updateFormField,
	);
	const saveSettings = useSettingsFormStore((state) => state.saveSettings);
	const testJira = useSettingsFormStore((state) => state.testJira);
	const testGitlab = useSettingsFormStore((state) => state.testGitlab);
	const testCalendar = useSettingsFormStore((state) => state.testCalendar);
	const testRescueTime = useSettingsFormStore((state) => state.testRescueTime);
	const testGithub = useSettingsFormStore((state) => state.testGithub);
	const loadFromConfig = useSettingsFormStore((state) => state.loadFromConfig);
	const resetForm = useSettingsFormStore((state) => state.resetForm);
	const replaceFormData = useSettingsFormStore(
		(state) => state.replaceFormData,
	);

	const calendarMappings = useUserDataStore((s) => s.calendarMappings);
	const addCalendarMapping = useUserDataStore((s) => s.addCalendarMapping);
	const removeCalendarMapping = useUserDataStore(
		(s) => s.removeCalendarMapping,
	);
	const updateCalendarMapping = useUserDataStore(
		(s) => s.updateCalendarMapping,
	);
	const replaceCalendarMappings = useUserDataStore(
		(s) => s.replaceCalendarMappings,
	);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [internalActiveSection, setInternalActiveSection] = useState<string>(
		SETTINGS_SECTION_IDS.connection,
	);
	const activeSection = controlledActiveSection ?? internalActiveSection;
	const selectSection = onSelectSection ?? setInternalActiveSection;

	const jiraHostId = useId();
	const emailId = useId();
	const apiTokenId = useId();
	const corsProxyId = useId();
	const jqlFilterId = useId();
	const allowedUsersId = useId();
	const gitlabTokenId = useId();
	const gitlabHostId = useId();
	const rescueTimeKeyId = useId();
	const githubTokenId = useId();
	const timeRoundingId = useId();
	const themeId = useId();
	const includeAbsenceInCsvId = useId();
	const includeCsvProvenanceId = useId();
	const analyticsOptOutId = useId();
	const isDirty = JSON.stringify(formData) !== JSON.stringify(savedConfig);
	const canTestJira =
		!!formData.jiraHost.trim() &&
		!!formData.email.trim() &&
		!!formData.apiToken.trim();
	const canTestGitlab =
		!!formData.gitlabHost.trim() && !!formData.gitlabToken.trim();
	const canTestRescueTime = !!formData.rescueTimeApiKey.trim();
	const canTestGithub = !!formData.githubToken.trim();
	const hasCalendarFeeds = (formData.calendarFeeds ?? []).some((f) =>
		f.url.trim(),
	);
	const suggestionFeedEntries = useMemo(
		() => buildFeedEntries(formData.calendarFeeds, 'suggestion'),
		[formData.calendarFeeds],
	);
	const absenceFeedEntries = useMemo(
		() => buildFeedEntries(formData.calendarFeeds, 'absence'),
		[formData.calendarFeeds],
	);
	const holidayFeedEntries = useMemo(
		() => buildFeedEntries(formData.calendarFeeds, 'holiday'),
		[formData.calendarFeeds],
	);
	const sharedAbsenceFeedEntries = useMemo(
		() =>
			absenceFeedEntries.filter(
				({ feed }) => (feed.absenceAttribution ?? 'self') === 'shared',
			),
		[absenceFeedEntries],
	);
	const gitlabStatus = getServiceStatus(
		!!formData.gitlabHost.trim() || !!formData.gitlabToken.trim(),
		integrationTests.gitlab.loading,
		integrationTests.gitlab.result,
	);
	const rescueTimeStatus = getServiceStatus(
		!!formData.rescueTimeApiKey.trim(),
		integrationTests.rescuetime.loading,
		integrationTests.rescuetime.result,
	);
	const calendarStatus = getServiceStatus(
		hasCalendarFeeds,
		integrationTests.calendar.loading,
		integrationTests.calendar.result,
	);
	const githubStatus = getServiceStatus(
		!!formData.githubToken.trim(),
		integrationTests.github.loading,
		integrationTests.github.result,
	);
	const hasSharedAbsenceFeeds = sharedAbsenceFeedEntries.length > 0;
	const hasHolidayFeeds = holidayFeedEntries.length > 0;
	const showAbsenceAssignments =
		hasSharedAbsenceFeeds ||
		hasHolidayFeeds ||
		(formData.absenceAssignments ?? []).length > 0;
	const hasSharedAbsenceFeedsWithoutAssignments =
		hasSharedAbsenceFeeds && (formData.absenceAssignments ?? []).length === 0;
	const allowedUserSuggestions = useMemo(
		() =>
			uniqueEmailEntries([
				formData.email,
				savedConfig.email,
				...splitCsvEmailList(savedConfig.allowedUsers),
				...splitCsvEmailList(formData.allowedUsers),
			]),
		[
			formData.allowedUsers,
			formData.email,
			savedConfig.allowedUsers,
			savedConfig.email,
		],
	);
	const gitlabTroubleshooting = getGitlabTroubleshooting(
		integrationTests.gitlab.result?.success === false
			? integrationTests.gitlab.result.message
			: null,
	);

	const updateCalendarFeed = (index: number, patch: Partial<CalendarFeed>) => {
		const feeds = [...(formData.calendarFeeds ?? [])];
		feeds[index] = {
			...feeds[index],
			...patch,
		};
		updateFormField('calendarFeeds', feeds as never);
	};

	const removeCalendarFeed = (index: number) => {
		const feeds = (formData.calendarFeeds ?? []).filter((_, i) => i !== index);
		updateFormField('calendarFeeds', feeds as never);
	};

	const addCalendarFeed = (type: CalendarFeed['type']) => {
		const feeds: CalendarFeed[] = [
			...(formData.calendarFeeds ?? []),
			{ label: '', url: '', type },
		];
		updateFormField('calendarFeeds', feeds as never);
	};

	const addAbsenceAssignment = (assignment: AbsenceAssignment) => {
		updateFormField('absenceAssignments', [
			...(formData.absenceAssignments ?? []),
			assignment,
		] as never);
	};

	const updateAbsenceAssignment = (
		original: AbsenceAssignment,
		nextAssignment: AbsenceAssignment,
	) => {
		updateFormField(
			'absenceAssignments',
			(formData.absenceAssignments ?? []).map((assignment) =>
				assignment.pattern === original.pattern ? nextAssignment : assignment,
			) as never,
		);
	};

	const removeAbsenceAssignment = (target: AbsenceAssignment) => {
		updateFormField(
			'absenceAssignments',
			(formData.absenceAssignments ?? []).filter(
				(assignment) => assignment.pattern !== target.pattern,
			) as never,
		);
	};

	useEffect(() => {
		loadFromConfig();
	}, [loadFromConfig]);

	const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const { name, value, type, checked } = e.target;
		if (type === 'checkbox') {
			updateFormField(name as keyof typeof formData, checked as never);
		} else {
			updateFormField(name as keyof typeof formData, value as never);
		}
	};

	const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const { name, value } = e.target;
		updateFormField(name as keyof typeof formData, value as never);
	};

	const handleSave = () => {
		if (!isDirty) return;
		saveSettings();
		toast.success('Settings saved');
	};

	const handleExportSettings = () => {
		const userDataState = useUserDataStore.getState();
		const backup = createSettingsBackup(savedConfig, calendarMappings, {
			favorites: userDataState.favorites,
			templates: userDataState.templates,
			commentPresets: userDataState.commentPresets,
			dayNotes: userDataState.dayNotes,
			reportPresets: userDataState.reportPresets,
		});
		downloadAsFile(
			`${JSON.stringify(backup, null, 2)}\n`,
			'hoursmith-settings.json',
			'application/json;charset=utf-8',
		);
		toast.success('Settings exported');
	};

	const handleExportSharePack = () => {
		const sharePack = createSettingsSharePack(savedConfig, calendarMappings);
		downloadAsFile(
			`${JSON.stringify(sharePack, null, 2)}\n`,
			'hoursmith-share-pack.json',
			'application/json;charset=utf-8',
		);
		toast.success(
			'Share pack exported — excludes tokens, calendars, and personal data',
		);
	};

	const handleImportClick = () => {
		fileInputRef.current?.click();
	};

	// ADA-474: wipe the locally-stored config (including the Jira API token) from
	// localStorage and reset the in-memory config to defaults. Guarded by a
	// confirm so a stray click can't destroy a working setup.
	const handleClearLocalData = () => {
		const confirmed =
			typeof window === 'undefined' ||
			window.confirm(
				'Clear local data? This removes your saved configuration and Jira API token from this browser. This cannot be undone.',
			);
		if (!confirmed) return;
		const cleared = createDefaultConfig();
		useConfigStore.getState().setConfig(cleared);
		replaceFormData(cleared);
		try {
			window.localStorage?.removeItem('hoursmith-config');
		} catch {
			// Ignore storage access failures (private mode / disabled storage) —
			// the in-memory reset above is the source of truth either way.
		}
		toast.success('Local data cleared');
	};

	const handleImportSettings = async (
		e: React.ChangeEvent<HTMLInputElement>,
	) => {
		const file = e.target.files?.[0];
		if (!file) return;

		try {
			const content = await file.text();
			const imported = parseSettingsBackup(content, savedConfig);
			replaceFormData(imported.config);
			replaceCalendarMappings(imported.calendarMappings);
			if (imported.userData) {
				useUserDataStore.setState({
					favorites: imported.userData.favorites,
					templates: imported.userData.templates,
					commentPresets: imported.userData.commentPresets,
					dayNotes: imported.userData.dayNotes,
					reportPresets: imported.userData.reportPresets,
				});
			}
			toast.success(
				imported.kind === 'share-pack'
					? 'Share pack imported into the form'
					: 'Settings backup imported into the form',
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : 'Failed to import settings',
			);
		} finally {
			e.target.value = '';
		}
	};

	const configRailItems = SETTINGS_RAIL_ITEMS.filter(
		(item) => item.group === 'config',
	);
	const savedRailItems = SETTINGS_RAIL_ITEMS.filter(
		(item) => item.group === 'saved',
	);
	const dataSectionId = SETTINGS_SECTION_IDS.form;

	const renderRailItem = (item: (typeof SETTINGS_RAIL_ITEMS)[number]) => {
		const status = railStatus(setupModel, item.setupKey);
		const isActive = activeSection === item.id;
		return (
			<button
				key={item.id}
				type="button"
				className={`${styles.railItem} ${isActive ? styles.railItemActive : ''}`}
				aria-current={isActive ? 'true' : undefined}
				onClick={() => selectSection(item.id)}
			>
				{status ? (
					<span
						className={`${styles.railDot} ${
							status === 'ready'
								? styles.railDotReady
								: status === 'warning'
									? styles.railDotWarning
									: styles.railDotPending
						}`}
					/>
				) : (
					<span className={styles.railDot} />
				)}
				<span className={styles.railLabel}>{item.label}</span>
			</button>
		);
	};

	return (
		<div id={SETTINGS_SECTION_IDS.form} className={styles.form}>
			<input
				ref={fileInputRef}
				type="file"
				accept="application/json,.json"
				className={styles.hiddenInput}
				onChange={handleImportSettings}
			/>

			<div className={styles.layout}>
				<nav className={styles.rail} aria-label="Settings sections">
					<p className={styles.railGroupLabel}>Configuration</p>
					{configRailItems.map(renderRailItem)}
					<div className={styles.railSeparator} />
					<p className={styles.railGroupLabel}>Saved state</p>
					{savedRailItems.map(renderRailItem)}
				</nav>

				<div className={styles.panels}>
					{/*
					 * Every section component is still rendered with identical props and
					 * handlers — only visibility is gated by the active rail item, so
					 * field/store/test parity is unchanged. `hidden` keeps each section
					 * mounted (preserving its local input state) while showing one.
					 */}
					<div hidden={activeSection !== SETTINGS_SECTION_IDS.connection}>
						<ConnectionSection
							formData={formData}
							handleChange={handleChange}
							testJira={testJira}
							canTestJira={canTestJira}
							integrationTest={integrationTests.jira}
							jiraHostId={jiraHostId}
							emailId={emailId}
							apiTokenId={apiTokenId}
							corsProxyId={corsProxyId}
						/>
					</div>

					<div hidden={activeSection !== SETTINGS_SECTION_IDS.scope}>
						<ScopeSection
							jqlFilter={formData.jqlFilter}
							allowedUsers={formData.allowedUsers}
							allowedUserSuggestions={allowedUserSuggestions}
							handleChange={handleChange}
							onAllowedUsersChange={(nextValue) =>
								updateFormField('allowedUsers', nextValue as never)
							}
							jqlFilterId={jqlFilterId}
							allowedUsersId={allowedUsersId}
						/>
					</div>

					<div hidden={activeSection !== SETTINGS_SECTION_IDS.permissions}>
						<PermissionsSection
							canAddWorklogs={formData.canAddWorklogs}
							canEditWorklogs={formData.canEditWorklogs}
							canDeleteWorklogs={formData.canDeleteWorklogs}
							complianceReminderEnabled={formData.complianceReminderEnabled}
							handleChange={handleChange}
						/>
					</div>

					<div hidden={activeSection !== SETTINGS_SECTION_IDS.integrations}>
						<IntegrationsSection
							gitlabHost={formData.gitlabHost}
							gitlabToken={formData.gitlabToken}
							rescueTimeApiKey={formData.rescueTimeApiKey}
							absenceAssignments={formData.absenceAssignments ?? []}
							gitlabHostId={gitlabHostId}
							gitlabTokenId={gitlabTokenId}
							rescueTimeKeyId={rescueTimeKeyId}
							githubToken={formData.githubToken}
							githubTokenId={githubTokenId}
							gitlabStatus={gitlabStatus}
							rescueTimeStatus={rescueTimeStatus}
							calendarStatus={calendarStatus}
							githubStatus={githubStatus}
							gitlabTroubleshooting={gitlabTroubleshooting}
							integrationTests={integrationTests}
							testGitlab={testGitlab}
							testRescueTime={testRescueTime}
							testCalendar={testCalendar}
							testGithub={testGithub}
							canTestGitlab={canTestGitlab}
							canTestRescueTime={canTestRescueTime}
							hasCalendarFeeds={hasCalendarFeeds}
							canTestGithub={canTestGithub}
							suggestionFeedEntries={suggestionFeedEntries}
							absenceFeedEntries={absenceFeedEntries}
							holidayFeedEntries={holidayFeedEntries}
							hasSharedAbsenceFeedsWithoutAssignments={
								hasSharedAbsenceFeedsWithoutAssignments
							}
							showAbsenceAssignments={showAbsenceAssignments}
							addCalendarFeed={addCalendarFeed}
							updateCalendarFeed={updateCalendarFeed}
							removeCalendarFeed={removeCalendarFeed}
							calendarMappings={calendarMappings}
							addCalendarMapping={addCalendarMapping}
							updateCalendarMapping={updateCalendarMapping}
							removeCalendarMapping={removeCalendarMapping}
							addAbsenceAssignment={addAbsenceAssignment}
							updateAbsenceAssignment={updateAbsenceAssignment}
							removeAbsenceAssignment={removeAbsenceAssignment}
							allowedUserSuggestions={allowedUserSuggestions}
							handleChange={handleChange}
						/>
					</div>

					<div hidden={activeSection !== SETTINGS_SECTION_IDS.preferences}>
						<PreferencesSection
							theme={formData.theme}
							timeRounding={formData.timeRounding}
							includeAbsenceInCsv={formData.includeAbsenceInCsv}
							includeCsvProvenance={formData.includeCsvProvenance}
							analyticsOptOut={formData.analyticsOptOut ?? false}
							handleSelectChange={handleSelectChange}
							handleChange={handleChange}
							themeId={themeId}
							timeRoundingId={timeRoundingId}
							includeAbsenceInCsvId={includeAbsenceInCsvId}
							includeCsvProvenanceId={includeCsvProvenanceId}
							analyticsOptOutId={analyticsOptOutId}
						/>
					</div>

					<div hidden={activeSection !== dataSectionId}>
						<section className={styles.section}>
							<h2 className={styles.dataSectionTitle}>Data &amp; backup</h2>
							<p className={styles.dataSectionHint}>
								Back up your configuration, share a secret-free pack with a
								teammate, or import a saved file. Save and Discard for the
								current form are always available in the bar below.
							</p>

							<div className={styles.dataActionRow}>
								<div className={styles.dataActionCopy}>
									<strong>Full backup</strong>
									<p className={styles.dataActionWarning}>
										Includes your API token — keep it private. Use{' '}
										<strong>Share Pack</strong> to share with teammates.
									</p>
								</div>
								<Button
									type="button"
									variant="secondary"
									onClick={handleExportSettings}
								>
									Backup
								</Button>
							</div>

							<div className={styles.dataActionRow}>
								<div className={styles.dataActionCopy}>
									<strong>Share Pack</strong>
									<p className={styles.dataSectionHint}>
										The safe way to share with a teammate — strips your API
										token and other local secrets before export.
									</p>
								</div>
								<Button
									type="button"
									variant="secondary"
									onClick={handleExportSharePack}
								>
									Share Pack
								</Button>
							</div>

							<div className={styles.dataActionRow}>
								<div className={styles.dataActionCopy}>
									<strong>Clear local data</strong>
									<p className={styles.dataSectionHint}>
										Removes your saved configuration and Jira API token from
										this browser. You can also{' '}
										<a
											href="https://id.atlassian.com/manage-profile/security/api-tokens"
											target="_blank"
											rel="noopener noreferrer"
										>
											revoke your Jira token
										</a>{' '}
										at Atlassian.
									</p>
								</div>
								<Button
									type="button"
									variant="secondary"
									onClick={handleClearLocalData}
								>
									Clear local data
								</Button>
							</div>
						</section>
					</div>
				</div>
			</div>

			<div className={styles.saveBar} aria-live="polite">
				<div className={styles.formStatusText}>
					<strong>{isDirty ? 'Unsaved changes' : 'Settings up to date'}</strong>
					<span>
						{isDirty
							? 'Review and save when you are ready.'
							: 'The form matches your saved configuration.'}
					</span>
				</div>
				<div className={styles.buttonGroup}>
					<Button
						type="button"
						variant="secondary"
						onClick={handleExportSettings}
					>
						Backup
					</Button>
					<Button
						type="button"
						variant="secondary"
						onClick={handleExportSharePack}
					>
						Share Pack
					</Button>
					<Button type="button" variant="secondary" onClick={handleImportClick}>
						Import
					</Button>
					<Button
						type="button"
						variant="secondary"
						onClick={resetForm}
						disabled={!isDirty}
					>
						Discard
					</Button>
					<Button type="button" disabled={!isDirty} onClick={handleSave}>
						Save
					</Button>
				</div>
			</div>
		</div>
	);
};
