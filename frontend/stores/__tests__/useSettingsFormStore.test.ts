import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackEvent } from '../../analytics';
import {
	__resetProxyBridgeForTests,
	setHostedProxyUrl,
	setSupabaseAccessToken,
} from '../../services/proxyUrlBridge';
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
	githubToken: '',
	githubHost: '',
	rescueTimeApiKey: '',
	calendarFeeds: [],
	absenceAssignments: [],
	complianceReminderEnabled: false,
	theme: 'system' as const,
	timeRounding: 'off' as const,
	includeAbsenceInCsv: true,
	includeCsvProvenance: false,
	analyticsOptOut: false,
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
					github: { loading: false, result: null },
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
			github: { loading: false, result: null },
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
			__resetProxyBridgeForTests();
		});

		it('warns on email mismatch and does not report success (ADA-436)', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: { ...baseConfig, email: 'settings@example.com' },
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						github: { loading: false, result: null },
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
						github: { loading: false, result: null },
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
						github: { loading: false, result: null },
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
						github: { loading: false, result: null },
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
						github: { loading: false, result: null },
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

		it('explains an unreachable host via the hosted proxy and points to Override (ADA-523)', async () => {
			// Premium/hosted user with a self-hosted Jira the hosted proxy can't reach
			// (internal/VPN-only host). The proxy returns 502 upstream_error.
			setHostedProxyUrl('https://hoursmith.io/api/proxy');
			setSupabaseAccessToken('supabase-jwt');
			act(() => {
				useSettingsFormStore.setState({
					formData: {
						...baseConfig,
						jiraHost: 'ticket.rsint.net',
						// A leftover local-proxy value that must NOT leak into the message.
						corsProxy: 'http://localhost:8081',
					},
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						github: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});

			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(JSON.stringify({ error: 'upstream_error' }), {
					status: 502,
				}),
			);

			await act(async () => {
				await useSettingsFormStore.getState().testJira();
			});

			const result =
				useSettingsFormStore.getState().integrationTests.jira.result;
			expect(result?.success).toBe(false);
			// Names the real Jira host and the hosted proxy, points to Override...
			expect(result?.message).toContain('ticket.rsint.net');
			expect(result?.message).toMatch(/Override/i);
			expect(result?.message).toMatch(/hosted proxy/i);
			// ...and does NOT show the misleading pre-rewrite localhost label.
			expect(result?.message).not.toContain('localhost:8081');
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
					github: { loading: false, result: null },
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

	describe('testRescueTime', () => {
		afterEach(() => {
			vi.restoreAllMocks();
			// Bridge state is module-scoped — reset so a hosted-mode test can't leak
			// into the self-hosted / direct cases (which assert on no hosted proxy).
			__resetProxyBridgeForTests();
		});

		// RescueTime's API sends no CORS headers, so a browser fetch can only reach
		// it through a user-configured CORS proxy. With no proxy the request goes
		// directly to rescuetime.com and the browser rejects it with an opaque
		// `TypeError: NetworkError`. Fail fast with actionable copy instead, and
		// never even attempt the doomed direct request.
		it('fails fast with proxy guidance when no CORS proxy is configured', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: {
						...baseConfig,
						rescueTimeApiKey: 'rt-secret-key',
						corsProxy: '',
					},
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						github: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});

			const fetchSpy = vi.spyOn(globalThis, 'fetch');

			await act(async () => {
				await useSettingsFormStore.getState().testRescueTime();
			});

			const result =
				useSettingsFormStore.getState().integrationTests.rescuetime.result;
			expect(result?.success).toBe(false);
			expect(result?.message).toMatch(/CORS proxy/i);
			expect(result?.message).toMatch(/Connection settings/i);
			// Never issue the request that's guaranteed to CORS-fail.
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(
				useSettingsFormStore.getState().integrationTests.rescuetime.loading,
			).toBe(false);
		});

		it('surfaces an actionable error when the CORS proxy is unreachable', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: {
						...baseConfig,
						rescueTimeApiKey: 'rt-secret-key',
						corsProxy: 'http://localhost:8081',
					},
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						github: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});

			// fetch rejects with a TypeError on network / CORS failure.
			vi.spyOn(globalThis, 'fetch').mockRejectedValue(
				new TypeError('NetworkError when attempting to fetch resource'),
			);

			await act(async () => {
				await useSettingsFormStore.getState().testRescueTime();
			});

			const result =
				useSettingsFormStore.getState().integrationTests.rescuetime.result;
			expect(result?.success).toBe(false);
			expect(result?.message).toMatch(/proxy/i);
			expect(result?.message).toContain('http://localhost:8081');
			// The API key lives in the request URL — it must never leak into UI copy.
			expect(result?.message).not.toContain('rt-secret-key');
		});

		it('reports the activity count on a successful test', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: {
						...baseConfig,
						rescueTimeApiKey: 'rt-secret-key',
						corsProxy: 'http://localhost:8081',
					},
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						github: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});

			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(JSON.stringify({ rows: [[], []] }), { status: 200 }),
			);

			await act(async () => {
				await useSettingsFormStore.getState().testRescueTime();
			});

			const result =
				useSettingsFormStore.getState().integrationTests.rescuetime.result;
			expect(result?.success).toBe(true);
			expect(result?.message).toContain('2 activities');
		});

		it('routes through the hosted relay (key in header, not URL) for entitled users', async () => {
			act(() => {
				// No user-configured proxy — entitlement alone should suffice.
				useSettingsFormStore.setState({
					formData: {
						...baseConfig,
						rescueTimeApiKey: 'rt-secret-key',
						corsProxy: '',
					},
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						calendar: { loading: false, result: null },
						github: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});
			// Premium auth normally pushes these into the bridge.
			setHostedProxyUrl('https://hoursmith.io/api/proxy');
			setSupabaseAccessToken('supabase-jwt');

			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValue(
					new Response(JSON.stringify({ rows: [[]] }), { status: 200 }),
				);

			await act(async () => {
				await useSettingsFormStore.getState().testRescueTime();
			});

			const result =
				useSettingsFormStore.getState().integrationTests.rescuetime.result;
			expect(result?.success).toBe(true);

			const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
			// Hits our own relay, not rescuetime.com — and the key is NOT in the URL.
			expect(String(calledUrl)).toContain(
				'https://hoursmith.io/api/rescuetime',
			);
			expect(String(calledUrl)).not.toContain('rt-secret-key');
			expect(String(calledUrl)).not.toContain('rescuetime.com');
			// Key + Supabase JWT travel in headers.
			const headers = (calledInit?.headers ?? {}) as Record<string, string>;
			expect(headers['x-rescuetime-key']).toBe('rt-secret-key');
			expect(headers.authorization).toBe('Bearer supabase-jwt');
		});
	});

	describe('testGithub', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('reports connected + coverage on success', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: { ...baseConfig, githubToken: 'tok' },
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						github: { loading: false, result: null },
						calendar: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});

			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ login: 'me', name: 'Me' }), {
						status: 200,
					}),
				)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify([
							{
								type: 'PushEvent',
								created_at: new Date().toISOString(),
								payload: {
									ref: 'refs/heads/PUMA-1',
									commits: [{ message: 'x' }],
								},
							},
						]),
						{ status: 200 },
					),
				)
				.mockResolvedValueOnce(new Response('[]', { status: 200 }))
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 }),
				);

			await act(async () => {
				await useSettingsFormStore.getState().testGithub();
			});

			const result =
				useSettingsFormStore.getState().integrationTests.github.result;
			expect(result?.success).toBe(true);
			expect(result?.message).toContain('@me');
			expect(result?.message).not.toContain('tok'); // never echo the token
		});

		it('maps 401 to a token-rejected message', async () => {
			act(() => {
				useSettingsFormStore.setState({
					formData: { ...baseConfig, githubToken: 'bad' },
					integrationTests: {
						jira: { loading: false, result: null },
						gitlab: { loading: false, result: null },
						github: { loading: false, result: null },
						calendar: { loading: false, result: null },
						rescuetime: { loading: false, result: null },
					},
				});
			});
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response('{}', { status: 401 }),
			);

			await act(async () => {
				await useSettingsFormStore.getState().testGithub();
			});

			const result =
				useSettingsFormStore.getState().integrationTests.github.result;
			expect(result?.success).toBe(false);
			expect(result?.message).toMatch(/401|token/i);
		});
	});
});
