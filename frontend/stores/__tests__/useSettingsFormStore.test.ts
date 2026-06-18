import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackEvent } from '../../analytics';
import { useConfigStore } from '../useConfigStore';
import { useSettingsFormStore } from '../useSettingsFormStore';
import { useUIStore } from '../useUIStore';

// Spy on analytics so we can assert the `jira_connection_tested` event shape
// (result + fixed failure-reason enum + http_status + duration_bucket) without
// sending anything.
vi.mock('../../analytics', () => ({ trackEvent: vi.fn() }));
const trackEventMock = vi.mocked(trackEvent);

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
		trackEventMock.mockClear();
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

	describe('testJira', () => {
		afterEach(() => {
			vi.restoreAllMocks();
			vi.useRealTimers();
		});

		it('warns on email mismatch and does not report success (ADA-436)', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: { ...baseConfig, email: 'settings@example.com' },
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});

			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(
					JSON.stringify({
						displayName: 'Token User',
						emailAddress: 'token@example.com',
					}),
					{ status: 200 },
				),
			);

			await act(async () => {
				await useSettingsFormStore.getState().testJira();
			});

			const result =
				useSettingsFormStore.getState().integrationTests.jira.result;
			expect(result?.success).toBe(false);
			expect(result?.message).toContain('token@example.com');
			expect(result?.message).toContain('settings@example.com');
			expect(
				useSettingsFormStore.getState().integrationTests.jira.loading,
			).toBe(false);

			// Analytics: a benign failure event with the email_mismatch enum — no
			// email / host text in the props.
			expect(trackEventMock).toHaveBeenCalledWith(
				'jira_connection_tested',
				expect.objectContaining({
					result: 'failure',
					failure_reason: 'email_mismatch',
					http_status: 200,
				}),
			);
			const mismatchProps = trackEventMock.mock.calls.at(-1)?.[1] as Record<
				string,
				unknown
			>;
			expect(JSON.stringify(mismatchProps)).not.toContain('@example.com');
		});

		it('reports success when token email matches settings email (ADA-436)', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: { ...baseConfig, email: 'user@example.com' },
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});

			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(
					JSON.stringify({
						displayName: 'User',
						emailAddress: 'USER@example.com',
					}),
					{ status: 200 },
				),
			);

			await act(async () => {
				await useSettingsFormStore.getState().testJira();
			});

			const result =
				useSettingsFormStore.getState().integrationTests.jira.result;
			expect(result?.success).toBe(true);
			expect(result?.message).toContain('Connected as User');

			// Analytics: a success event with the 'ok' reason and a duration bucket.
			expect(trackEventMock).toHaveBeenCalledWith(
				'jira_connection_tested',
				expect.objectContaining({
					result: 'success',
					failure_reason: 'ok',
					http_status: 200,
					duration_bucket: expect.stringMatching(/^(<1s|1-3s|3-10s|>10s)$/),
				}),
			);
		});

		it('maps an HTTP 401 to the auth failure enum (no raw message in props)', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: { ...baseConfig },
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});

			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response('nope', { status: 401 }),
			);

			await act(async () => {
				await useSettingsFormStore.getState().testJira();
			});

			expect(
				useSettingsFormStore.getState().integrationTests.jira.result?.success,
			).toBe(false);
			expect(trackEventMock).toHaveBeenCalledWith(
				'jira_connection_tested',
				expect.objectContaining({
					result: 'failure',
					failure_reason: 'auth',
					http_status: 401,
				}),
			);
			// The fixed enum is sent, never the raw status-specific message text.
			const authProps = trackEventMock.mock.calls.at(-1)?.[1] as Record<
				string,
				unknown
			>;
			expect(JSON.stringify(authProps)).not.toContain('jira.example.com');
		});

		it('maps a CORS / network failure to the cors enum', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: { ...baseConfig },
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});

			vi.spyOn(globalThis, 'fetch').mockRejectedValue(
				new TypeError('Failed to fetch'),
			);

			await act(async () => {
				await useSettingsFormStore.getState().testJira();
			});

			expect(trackEventMock).toHaveBeenCalledWith(
				'jira_connection_tested',
				expect.objectContaining({
					result: 'failure',
					failure_reason: 'cors',
					http_status: 0,
				}),
			);
		});

		it('aborts and surfaces an actionable timeout message (ADA-444)', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: { ...baseConfig },
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});

			// Simulate fetch rejecting with an AbortError, as AbortController.abort()
			// would after the timeout fires.
			vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
				return new Promise((_resolve, reject) => {
					const signal = (init as RequestInit | undefined)?.signal;
					signal?.addEventListener('abort', () => {
						reject(new DOMException('Aborted', 'AbortError'));
					});
				});
			});

			vi.useFakeTimers();
			const promise = useSettingsFormStore.getState().testJira();
			await vi.advanceTimersByTimeAsync(20_000);
			await promise;

			const result =
				useSettingsFormStore.getState().integrationTests.jira.result;
			expect(result?.success).toBe(false);
			expect(result?.message).toMatch(/within 20s/);
			expect(result?.message).toMatch(/jira\.example\.com/);
			expect(
				useSettingsFormStore.getState().integrationTests.jira.loading,
			).toBe(false);

			// Analytics: a timeout maps to the timeout enum.
			expect(trackEventMock).toHaveBeenCalledWith(
				'jira_connection_tested',
				expect.objectContaining({
					result: 'failure',
					failure_reason: 'timeout',
				}),
			);
		});
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
