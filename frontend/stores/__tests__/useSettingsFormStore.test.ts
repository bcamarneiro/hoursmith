import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useConfigStore } from '../useConfigStore';
import { useSettingsFormStore } from '../useSettingsFormStore';
import { useUIStore } from '../useUIStore';

const baseConfig = {
	jiraHost: 'jira.example.com',
	email: 'user@example.com',
	apiToken: 'token',
	corsProxy: '',
	jqlFilter: '',
	allowedUsers: '',
	canAddWorklogs: true,
	canEditWorklogs: true,
	canDeleteWorklogs: true,
	gitlabToken: '',
	gitlabHost: '',
	rescueTimeApiKey: '',
	calendarFeeds: [],
	absenceAssignments: [],
	complianceReminderEnabled: false,
	theme: 'system' as const,
	timeRounding: 'off' as const,
	includeAbsenceInCsv: true,
	includeCsvProvenance: false,
};

describe('useSettingsFormStore', () => {
	beforeEach(() => {
		act(() => {
			useConfigStore.setState({ config: baseConfig });
			useSettingsFormStore.setState({
				formData: baseConfig,
				integrationTests: {
					jira: {
						loading: false,
						result: { success: true, message: 'Connected' },
					},
					gitlab: {
						loading: false,
						result: { success: false, message: 'Invalid token' },
					},
					calendar: { loading: false, result: null },
					rescuetime: { loading: true, result: null },
				},
			});
			useUIStore.setState({
				selectedTab: 'home',
				preferences: {
					hideWeekends: false,
					compactView: false,
				},
				selectedProject: '',
				expandedUsers: {},
				installPromptDismissed: false,
				jiraConnectionEvidenceAt: null,
				jiraConnectionEvidenceFingerprint: null,
				jiraConnectionEvidenceSource: null,
			});
		});
	});

	it('resets integration test state when loading from config', () => {
		act(() => {
			useSettingsFormStore.getState().loadFromConfig();
		});

		expect(useSettingsFormStore.getState().formData).toEqual(baseConfig);
		expect(useSettingsFormStore.getState().integrationTests).toEqual({
			jira: { loading: false, result: null },
			gitlab: { loading: false, result: null },
			calendar: { loading: false, result: null },
			rescuetime: { loading: false, result: null },
		});
	});

	it('saves the form back to config and clears stale test results', () => {
		act(() => {
			useSettingsFormStore
				.getState()
				.updateFormField('jiraHost', 'next.example.com');
			useSettingsFormStore.getState().saveSettings();
		});

		expect(useConfigStore.getState().config.jiraHost).toBe('next.example.com');
		expect(
			useSettingsFormStore.getState().integrationTests.jira.result,
		).toBeNull();
		expect(
			useSettingsFormStore.getState().integrationTests.gitlab.result,
		).toBeNull();
	});

	it('normalizes host-like fields when saving', () => {
		act(() => {
			useSettingsFormStore
				.getState()
				.updateFormField('jiraHost', ' https://jira.example.com/ ');
			useSettingsFormStore
				.getState()
				.updateFormField('corsProxy', ' http://localhost:8081/ ');
			useSettingsFormStore.getState().saveSettings();
		});

		expect(useConfigStore.getState().config.jiraHost).toBe('jira.example.com');
		expect(useConfigStore.getState().config.corsProxy).toBe(
			'http://localhost:8081',
		);
		expect(useSettingsFormStore.getState().formData.jiraHost).toBe(
			'jira.example.com',
		);
	});

	it('keeps Jira evidence when saving a tested connection', () => {
		act(() => {
			useSettingsFormStore.getState().saveSettings();
		});

		expect(useUIStore.getState().jiraConnectionEvidenceAt).toBeTruthy();
		expect(useUIStore.getState().jiraConnectionEvidenceSource).toBe('test');
		expect(useUIStore.getState().jiraConnectionEvidenceFingerprint).toBe(
			'jira.example.com::user@example.com::token::',
		);
	});

	it('clears Jira evidence when saving a different connection without a fresh pass', () => {
		act(() => {
			useUIStore
				.getState()
				.markJiraConnectionEvidence(
					'jira.example.com::user@example.com::token::',
					'fetch',
					'2026-04-08T10:00:00.000Z',
				);
			useSettingsFormStore.setState({
				integrationTests: {
					jira: { loading: false, result: null },
					gitlab: { loading: false, result: null },
					calendar: { loading: false, result: null },
					rescuetime: { loading: false, result: null },
				},
			});
			useSettingsFormStore
				.getState()
				.updateFormField('jiraHost', 'next.example.com');
			useSettingsFormStore.getState().saveSettings();
		});

		expect(useUIStore.getState().jiraConnectionEvidenceAt).toBeNull();
		expect(useUIStore.getState().jiraConnectionEvidenceFingerprint).toBeNull();
		expect(useUIStore.getState().jiraConnectionEvidenceSource).toBeNull();
	});
});
