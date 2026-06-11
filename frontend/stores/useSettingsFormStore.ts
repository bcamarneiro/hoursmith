import { create } from 'zustand';
import { toLocalDateString } from '../react/utils/date';
import { logger } from '../react/utils/logger';
import {
	buildGitlabBaseUrl,
	describeGitlabConnectionError,
	normalizeGitlabHost,
} from '../services/gitlabService';
import { rewriteForHostedProxy } from '../services/jiraGateway';
import { type Config, normalizeConfig, useConfigStore } from './useConfigStore';
import { buildJiraConnectionFingerprint, useUIStore } from './useUIStore';

export interface IntegrationTestResult {
	loading: boolean;
	result: { success: boolean; message: string } | null;
}

export interface SettingsIntegrationTests {
	jira: IntegrationTestResult;
	gitlab: IntegrationTestResult;
	calendar: IntegrationTestResult;
	rescuetime: IntegrationTestResult;
}

interface SettingsFormState {
	// Form state (separate from saved config)
	formData: Config;

	// Per-integration test state
	integrationTests: SettingsIntegrationTests;

	// Actions
	updateFormField: <K extends keyof Config>(field: K, value: Config[K]) => void;
	replaceFormData: (config: Config) => void;
	loadFromConfig: () => void;
	saveSettings: () => void;
	resetForm: () => void;
	testJira: () => Promise<void>;
	testGitlab: () => Promise<void>;
	testCalendar: () => Promise<void>;
	testRescueTime: () => Promise<void>;
}

const emptyTest: IntegrationTestResult = { loading: false, result: null };
const resetIntegrationTests = () => ({
	jira: { ...emptyTest },
	gitlab: { ...emptyTest },
	calendar: { ...emptyTest },
	rescuetime: { ...emptyTest },
});

export const useSettingsFormStore = create<SettingsFormState>((set, get) => ({
	// Initialize form data from config store
	formData: useConfigStore.getState().config,

	integrationTests: {
		...resetIntegrationTests(),
	},

	updateFormField: <K extends keyof Config>(field: K, value: Config[K]) => {
		set((state) => ({
			formData: {
				...state.formData,
				[field]: value,
			},
		}));
	},

	replaceFormData: (config) => {
		set({ formData: config, integrationTests: resetIntegrationTests() });
	},

	loadFromConfig: () => {
		const config = useConfigStore.getState().config;
		set({ formData: config, integrationTests: resetIntegrationTests() });
	},

	saveSettings: () => {
		const { formData } = get();
		const savedConfig = useConfigStore.getState().config;
		const normalizedConfig = normalizeConfig(formData);
		const nextFingerprint = buildJiraConnectionFingerprint(normalizedConfig);
		const savedFingerprint = buildJiraConnectionFingerprint(savedConfig);
		const jiraWasVerified =
			get().integrationTests.jira.result?.success === true;
		useConfigStore.getState().setConfig(normalizedConfig);

		if (jiraWasVerified && nextFingerprint) {
			useUIStore.getState().markJiraConnectionEvidence(nextFingerprint, 'test');
		} else if (savedFingerprint !== nextFingerprint) {
			useUIStore.getState().clearJiraConnectionEvidence();
		}

		set({
			formData: normalizedConfig,
			integrationTests: resetIntegrationTests(),
		});
	},

	resetForm: () => {
		const config = useConfigStore.getState().config;
		set({
			formData: config,
			integrationTests: resetIntegrationTests(),
		});
	},

	testJira: async () => {
		set((s) => ({
			integrationTests: {
				...s.integrationTests,
				jira: { loading: true, result: null },
			},
		}));

		try {
			const { formData } = get();
			const normalizedConfig = normalizeConfig(formData);

			const host = normalizedConfig.corsProxy
				? `${normalizedConfig.corsProxy.replace(/\/$/, '')}/https://${normalizedConfig.jiraHost}`
				: `https://${normalizedConfig.jiraHost}`;

			const baseHeaders: Record<string, string> = {
				Authorization: `Bearer ${normalizedConfig.apiToken}`,
				Accept: 'application/json',
				'X-Atlassian-Token': 'no-check',
			};
			// Route through the hosted proxy for entitled premium users (no-op in
			// direct/self-hosted mode). The connection test previously fetched Jira
			// directly, which a hosted user's browser can't do (CORS) — ADA-382.
			const jiraReq = (url: string) =>
				rewriteForHostedProxy(url, baseHeaders, {
					jiraHost: normalizedConfig.jiraHost,
					email: normalizedConfig.email,
					apiToken: normalizedConfig.apiToken,
				});

			const startTime = performance.now();
			const myselfReq = jiraReq(`${host}/rest/api/2/myself`);
			const myselfRes = await fetch(myselfReq.url, {
				headers: myselfReq.headers,
			});
			if (!myselfRes.ok) {
				throw new Error(`Jira API error: ${myselfRes.status}`);
			}
			const myself = (await myselfRes.json()) as { displayName?: string };
			const duration = Math.round(performance.now() - startTime);
			logger.debug(`[Test] Jira OK in ${duration}ms: ${myself.displayName}`);

			// Auto-detect worklog permissions
			try {
				const permsReq = jiraReq(
					`${host}/rest/api/2/mypermissions?permissions=WORK_ON_ISSUES,EDIT_ALL_WORKLOGS,EDIT_OWN_WORKLOGS,DELETE_ALL_WORKLOGS,DELETE_OWN_WORKLOGS`,
				);
				const permsRes = await fetch(permsReq.url, {
					headers: permsReq.headers,
				});
				if (permsRes.ok) {
					const perms = (await permsRes.json()) as {
						permissions?: Record<string, { havePermission: boolean }>;
					};
					const p = perms.permissions;
					if (p) {
						const canAdd = p.WORK_ON_ISSUES?.havePermission ?? true;
						const canEdit =
							(p.EDIT_ALL_WORKLOGS?.havePermission ||
								p.EDIT_OWN_WORKLOGS?.havePermission) ??
							true;
						const canDelete =
							(p.DELETE_ALL_WORKLOGS?.havePermission ||
								p.DELETE_OWN_WORKLOGS?.havePermission) ??
							true;
						set((state) => ({
							formData: {
								...state.formData,
								canAddWorklogs: canAdd,
								canEditWorklogs: canEdit,
								canDeleteWorklogs: canDelete,
							},
						}));
					}
				}
			} catch {
				// permissions check is optional
			}

			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					jira: {
						loading: false,
						result: {
							success: true,
							message: `Connected as ${myself.displayName}`,
						},
					},
				},
			}));

			const currentFingerprint =
				buildJiraConnectionFingerprint(normalizedConfig);
			const savedFingerprint = buildJiraConnectionFingerprint(
				useConfigStore.getState().config,
			);
			if (currentFingerprint === savedFingerprint && currentFingerprint) {
				useUIStore
					.getState()
					.markJiraConnectionEvidence(currentFingerprint, 'test');
			}
		} catch (error) {
			logger.error('[Test] Jira failed:', error);
			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					jira: {
						loading: false,
						result: {
							success: false,
							message:
								error instanceof Error ? error.message : 'Connection failed',
						},
					},
				},
			}));
		}
	},

	testGitlab: async () => {
		set((s) => ({
			integrationTests: {
				...s.integrationTests,
				gitlab: { loading: true, result: null },
			},
		}));

		try {
			const { formData } = get();
			const normalizedConfig = normalizeConfig(formData);
			if (!normalizedConfig.gitlabToken || !normalizedConfig.gitlabHost) {
				throw new Error('GitLab host and token are required');
			}

			const cleanHost = normalizeGitlabHost(normalizedConfig.gitlabHost);
			const baseUrl = buildGitlabBaseUrl(
				normalizedConfig.gitlabHost,
				normalizedConfig.corsProxy,
			);

			const res = await fetch(`${baseUrl}/api/v4/user`, {
				headers: {
					'PRIVATE-TOKEN': normalizedConfig.gitlabToken,
					Accept: 'application/json',
				},
			});

			if (!res.ok) {
				if (res.status === 401) {
					throw new Error(
						`GitLab rejected the token for ${cleanHost} (401). Check that the token is still active and has read_user or api scope.`,
					);
				}
				if (res.status === 403) {
					throw new Error(
						`GitLab accepted the request but denied access on ${cleanHost} (403). Check account access and PAT scopes.`,
					);
				}
				if (res.status === 404) {
					throw new Error(
						`Could not find the GitLab API on ${cleanHost} (404). Confirm the hostname and whether this self-hosted instance uses a custom base path.`,
					);
				}
				throw new Error(`GitLab API error on ${cleanHost}: ${res.status}.`);
			}

			const user = (await res.json()) as { username: string };
			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					gitlab: {
						loading: false,
						result: {
							success: true,
							message: `Connected as @${user.username} on ${cleanHost}`,
						},
					},
				},
			}));
		} catch (error) {
			logger.error('[Test] GitLab failed:', error);
			const { formData } = get();
			const cleanHost = formData.gitlabHost
				? normalizeGitlabHost(formData.gitlabHost)
				: 'the configured GitLab host';
			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					gitlab: {
						loading: false,
						result: {
							success: false,
							message: describeGitlabConnectionError(error, cleanHost),
						},
					},
				},
			}));
		}
	},

	testCalendar: async () => {
		set((s) => ({
			integrationTests: {
				...s.integrationTests,
				calendar: { loading: true, result: null },
			},
		}));

		try {
			const { formData } = get();
			const normalizedConfig = normalizeConfig(formData);
			const feeds = (normalizedConfig.calendarFeeds ?? []).filter((f) =>
				f.url.trim(),
			);
			if (feeds.length === 0) {
				throw new Error('No calendar feeds configured');
			}

			const results: string[] = [];
			for (const feed of feeds) {
				const url = normalizedConfig.corsProxy
					? `${normalizedConfig.corsProxy.replace(/\/$/, '')}/${feed.url}`
					: feed.url;
				const res = await fetch(url);
				if (!res.ok) {
					throw new Error(
						`Feed "${feed.label || feed.url}" returned ${res.status}`,
					);
				}
				const text = await res.text();
				if (!text.includes('BEGIN:VCALENDAR')) {
					throw new Error(
						`Feed "${feed.label || feed.url}" is not a valid ICS file`,
					);
				}
				const eventCount = (text.match(/BEGIN:VEVENT/g) || []).length;
				results.push(
					`${feed.label || 'Feed'}: ${eventCount} event${eventCount !== 1 ? 's' : ''}`,
				);
			}

			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					calendar: {
						loading: false,
						result: {
							success: true,
							message: results.join(', '),
						},
					},
				},
			}));
		} catch (error) {
			logger.error('[Test] Calendar failed:', error);
			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					calendar: {
						loading: false,
						result: {
							success: false,
							message:
								error instanceof Error ? error.message : 'Connection failed',
						},
					},
				},
			}));
		}
	},

	testRescueTime: async () => {
		set((s) => ({
			integrationTests: {
				...s.integrationTests,
				rescuetime: { loading: true, result: null },
			},
		}));

		try {
			const { formData } = get();
			const normalizedConfig = normalizeConfig(formData);
			if (!normalizedConfig.rescueTimeApiKey) {
				throw new Error('RescueTime API key is required');
			}

			const today = toLocalDateString(new Date());
			const params = new URLSearchParams({
				key: normalizedConfig.rescueTimeApiKey,
				perspective: 'interval',
				restrict_kind: 'activity',
				resolution_time: 'day',
				restrict_begin: today,
				restrict_end: today,
				format: 'json',
			});

			const baseUrl = 'https://www.rescuetime.com/anapi/data';
			const url = normalizedConfig.corsProxy
				? `${normalizedConfig.corsProxy.replace(/\/$/, '')}/${baseUrl}?${params}`
				: `${baseUrl}?${params}`;

			const res = await fetch(url);
			if (!res.ok) {
				if (res.status === 403) throw new Error('Invalid RescueTime API key');
				throw new Error(`RescueTime API error: ${res.status}`);
			}

			const data = (await res.json()) as { rows: unknown[] };
			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					rescuetime: {
						loading: false,
						result: {
							success: true,
							message: `Connected — ${data.rows.length} activit${data.rows.length !== 1 ? 'ies' : 'y'} today`,
						},
					},
				},
			}));
		} catch (error) {
			logger.error('[Test] RescueTime failed:', error);
			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					rescuetime: {
						loading: false,
						result: {
							success: false,
							message:
								error instanceof Error ? error.message : 'Connection failed',
						},
					},
				},
			}));
		}
	},
}));
