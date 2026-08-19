import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../useUIStore';

describe('useUIStore', () => {
	beforeEach(() => {
		// Reset store to defaults
		act(() => {
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

	describe('setSelectedTab', () => {
		it('should set selected tab to home', () => {
			act(() => {
				useUIStore.getState().setSelectedTab('home');
			});

			expect(useUIStore.getState().selectedTab).toBe('home');
		});

		it('should set selected tab to timesheet', () => {
			act(() => {
				useUIStore.getState().setSelectedTab('timesheet');
			});

			expect(useUIStore.getState().selectedTab).toBe('timesheet');
		});

		it('should set selected tab to settings', () => {
			act(() => {
				useUIStore.getState().setSelectedTab('settings');
			});

			expect(useUIStore.getState().selectedTab).toBe('settings');
		});
	});

	describe('updatePreferences', () => {
		it('should update hideWeekends preference', () => {
			act(() => {
				useUIStore.getState().updatePreferences({ hideWeekends: true });
			});

			expect(useUIStore.getState().preferences.hideWeekends).toBe(true);
			expect(useUIStore.getState().preferences.compactView).toBe(false);
		});

		it('should update compactView preference', () => {
			act(() => {
				useUIStore.getState().updatePreferences({ compactView: true });
			});

			expect(useUIStore.getState().preferences.compactView).toBe(true);
			expect(useUIStore.getState().preferences.hideWeekends).toBe(false);
		});

		it('should update multiple preferences at once', () => {
			act(() => {
				useUIStore
					.getState()
					.updatePreferences({ hideWeekends: true, compactView: true });
			});

			expect(useUIStore.getState().preferences.hideWeekends).toBe(true);
			expect(useUIStore.getState().preferences.compactView).toBe(true);
		});

		it('should preserve other preferences when updating one', () => {
			act(() => {
				useUIStore.getState().updatePreferences({ hideWeekends: true });
			});

			act(() => {
				useUIStore.getState().updatePreferences({ compactView: true });
			});

			expect(useUIStore.getState().preferences.hideWeekends).toBe(true);
			expect(useUIStore.getState().preferences.compactView).toBe(true);
		});
	});

	describe('setSelectedProject', () => {
		it('should set selected project', () => {
			act(() => {
				useUIStore.getState().setSelectedProject('PROJ');
			});

			expect(useUIStore.getState().selectedProject).toBe('PROJ');
		});

		it('should clear selected project', () => {
			act(() => {
				useUIStore.getState().setSelectedProject('PROJ');
			});

			act(() => {
				useUIStore.getState().setSelectedProject('');
			});

			expect(useUIStore.getState().selectedProject).toBe('');
		});

		it('should normalize selected project values', () => {
			act(() => {
				useUIStore.getState().setSelectedProject(' proj ');
			});

			expect(useUIStore.getState().selectedProject).toBe('PROJ');
		});
	});

	describe('toggleUserExpanded', () => {
		it('should expand user when collapsed', () => {
			act(() => {
				useUIStore.getState().toggleUserExpanded('Alex Thompson');
			});

			expect(useUIStore.getState().expandedUsers['Alex Thompson']).toBe(true);
		});

		it('should collapse user when expanded', () => {
			act(() => {
				useUIStore.getState().toggleUserExpanded('Alex Thompson');
			});

			act(() => {
				useUIStore.getState().toggleUserExpanded('Alex Thompson');
			});

			expect(
				useUIStore.getState().expandedUsers['Alex Thompson'],
			).toBeUndefined();
		});

		it('should handle multiple users independently', () => {
			act(() => {
				useUIStore.getState().toggleUserExpanded('Alex Thompson');
				useUIStore.getState().toggleUserExpanded('Sarah Johnson');
			});

			expect(useUIStore.getState().expandedUsers['Alex Thompson']).toBe(true);
			expect(useUIStore.getState().expandedUsers['Sarah Johnson']).toBe(true);

			act(() => {
				useUIStore.getState().toggleUserExpanded('Alex Thompson');
			});

			expect(
				useUIStore.getState().expandedUsers['Alex Thompson'],
			).toBeUndefined();
			expect(useUIStore.getState().expandedUsers['Sarah Johnson']).toBe(true);
		});
	});

	describe('resetPreferences', () => {
		it('should reset preferences to defaults', () => {
			act(() => {
				useUIStore
					.getState()
					.updatePreferences({ hideWeekends: true, compactView: true });
			});

			expect(useUIStore.getState().preferences.hideWeekends).toBe(true);
			expect(useUIStore.getState().preferences.compactView).toBe(true);

			act(() => {
				useUIStore.getState().resetPreferences();
			});

			expect(useUIStore.getState().preferences.hideWeekends).toBe(false);
			expect(useUIStore.getState().preferences.compactView).toBe(false);
		});

		it('should not affect other state', () => {
			act(() => {
				useUIStore.getState().setSelectedTab('timesheet');
				useUIStore.getState().setSelectedProject('PROJ');
				useUIStore.getState().updatePreferences({ hideWeekends: true });
			});

			act(() => {
				useUIStore.getState().resetPreferences();
			});

			expect(useUIStore.getState().selectedTab).toBe('timesheet');
			expect(useUIStore.getState().selectedProject).toBe('PROJ');
		});
	});

	describe('install prompt persistence', () => {
		it('should dismiss the install prompt', () => {
			act(() => {
				useUIStore.getState().dismissInstallPrompt();
			});

			expect(useUIStore.getState().installPromptDismissed).toBe(true);
		});

		it('should reset the install prompt dismissal', () => {
			act(() => {
				useUIStore.getState().dismissInstallPrompt();
			});

			act(() => {
				useUIStore.getState().resetInstallPrompt();
			});

			expect(useUIStore.getState().installPromptDismissed).toBe(false);
		});
	});

	describe('tempoSuspected', () => {
		it('tracks tempoSuspected (default false)', () => {
			expect(useUIStore.getState().tempoSuspected).toBe(false);
			useUIStore.getState().setTempoSuspected(true);
			expect(useUIStore.getState().tempoSuspected).toBe(true);
		});
	});

	describe('jira connection evidence', () => {
		it('marks Jira connection evidence with a fingerprint and source', () => {
			act(() => {
				useUIStore
					.getState()
					.markJiraConnectionEvidence(
						'jira.example.com::user@example.com::token::http://localhost:8081',
						'fetch',
						'2026-04-08T10:00:00.000Z',
					);
			});

			expect(useUIStore.getState().jiraConnectionEvidenceAt).toBe(
				'2026-04-08T10:00:00.000Z',
			);
			expect(useUIStore.getState().jiraConnectionEvidenceFingerprint).toBe(
				'jira.example.com::user@example.com::token::http://localhost:8081',
			);
			expect(useUIStore.getState().jiraConnectionEvidenceSource).toBe('fetch');
		});

		it('clears Jira connection evidence', () => {
			act(() => {
				useUIStore
					.getState()
					.markJiraConnectionEvidence(
						'jira.example.com::user@example.com::token::',
						'test',
					);
			});

			act(() => {
				useUIStore.getState().clearJiraConnectionEvidence();
			});

			expect(useUIStore.getState().jiraConnectionEvidenceAt).toBeNull();
			expect(
				useUIStore.getState().jiraConnectionEvidenceFingerprint,
			).toBeNull();
			expect(useUIStore.getState().jiraConnectionEvidenceSource).toBeNull();
		});
	});
});
