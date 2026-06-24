import { create } from 'zustand';
import { trackEvent } from '../analytics';
import { toLocalDateString } from '../react/utils/date';
import { logger } from '../react/utils/logger';
import {
	fetchGithubSuggestions,
	fetchGithubUser,
} from '../services/githubService';
import {
	buildGitlabBaseUrl,
	describeGitlabConnectionError,
	normalizeGitlabHost,
} from '../services/gitlabService';
import {
	getJiraGatewayMode,
	type JiraGatewayMode,
	rewriteForHostedProxy,
} from '../services/jiraGateway';
import {
	buildRescueTimeRequest,
	getRescueTimeGatewayMode,
} from '../services/rescueTimeGateway';
import { type Config, normalizeConfig, useConfigStore } from './useConfigStore';
import { buildJiraConnectionFingerprint, useUIStore } from './useUIStore';

export interface IntegrationTestResult {
	loading: boolean;
	result: { success: boolean; message: string } | null;
}

export interface SettingsIntegrationTests {
	jira: IntegrationTestResult;
	gitlab: IntegrationTestResult;
	github: IntegrationTestResult;
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
	testGithub: () => Promise<void>;
	testCalendar: () => Promise<void>;
	testRescueTime: () => Promise<void>;
}

/**
 * Connection-test network timeout (ADA-444). Without it, a hung proxy / Jira
 * leaves the request pending forever and the UI shows "Testing…" with no error.
 */
const JIRA_TEST_TIMEOUT_MS = 20_000;

/**
 * fetch() wrapper that aborts after `timeoutMs` and rethrows a typed timeout
 * error so callers can surface an actionable message. ADA-444.
 */
class TestTimeoutError extends Error {
	constructor(public readonly host: string) {
		super(`No response from ${host} within ${JIRA_TEST_TIMEOUT_MS / 1000}s`);
		this.name = 'TestTimeoutError';
	}
}

/**
 * A connection-test failure whose message is already user-ready (composed from
 * the HTTP status / proxy body). The catch handler surfaces it verbatim instead
 * of running its CORS/network heuristics — otherwise an actionable message that
 * happens to mention "CORS proxy" gets clobbered by the generic CORS copy.
 */
class JiraTestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'JiraTestError';
	}
}

async function fetchWithTimeout(
	input: string,
	init: RequestInit,
	timeoutMs: number,
	hostLabel: string,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} catch (error) {
		// AbortController.abort() surfaces as an AbortError DOMException.
		if (
			controller.signal.aborted ||
			(error instanceof DOMException && error.name === 'AbortError')
		) {
			throw new TestTimeoutError(hostLabel);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Status-specific copy for a failed Jira connection test (ADA-475). Mirrors the
 * GitLab test's status-specific messages right below `testJira`, instead of the
 * bare `Jira API error: <status>` it threw before. `host` is the effective Jira
 * (or proxy/Jira) base the request hit, so the message names what failed.
 */
function describeJiraTestStatus(status: number, host: string): string {
	if (status === 401) {
		return `Jira rejected the credentials for ${host} (401). Check the email and API token are correct and the token is still active.`;
	}
	if (status === 403) {
		return `Jira accepted the request but denied access on ${host} (403). Check the account's permissions.`;
	}
	if (status === 404) {
		return `Could not find the Jira API on ${host} (404). Confirm the host name (and proxy URL, if used).`;
	}
	if (status >= 500) {
		return `Jira returned a server error on ${host} (${status}). This is usually temporary — please retry.`;
	}
	return `Jira API error on ${host}: ${status}.`;
}

/**
 * Turn a non-OK `/myself` response into an actionable message (ADA-523).
 *
 * In `hosted` mode the request went to the Hoursmith proxy, not the user's
 * `corsProxy`, so the message must name `jiraHost` (not the stale pre-rewrite
 * label) and read the proxy's structured `{error, detail}` body:
 *   - 502 `upstream_error` → the proxy reached our servers but couldn't reach the
 *     Jira host. The #1 cause is an internal / VPN-only Jira (e.g. a corporate
 *     Server/DC instance) our cloud servers can't see — point the user at the
 *     "Override" escape hatch + a local CORS proxy.
 *   - 504 `upstream_timeout` → same guidance, framed as a timeout.
 *   - 400 `bad_request` → surface the proxy's own `detail` verbatim.
 * Otherwise fall back to the status-specific copy, labelled with `jiraHost`.
 */
async function describeJiraTestFailure(
	res: Response,
	mode: JiraGatewayMode,
	jiraHost: string,
): Promise<string> {
	const status = res.status;
	if (mode === 'hosted') {
		let proxyError: string | undefined;
		let proxyDetail: string | undefined;
		try {
			const body = (await res.json()) as {
				error?: unknown;
				detail?: unknown;
			} | null;
			if (typeof body?.error === 'string') proxyError = body.error;
			if (typeof body?.detail === 'string') proxyDetail = body.detail;
		} catch {
			// Non-JSON body (e.g. an upstream HTML error page) — fall through.
		}
		if (status === 502 || proxyError === 'upstream_error') {
			return `The Hoursmith hosted proxy couldn't reach ${jiraHost}. If this is an internal or VPN-only Jira, our servers can't see it — click "Override" above and run a local CORS proxy (npm run cors-proxy) on a machine that can reach ${jiraHost}.`;
		}
		if (status === 504 || proxyError === 'upstream_timeout') {
			return `The Hoursmith hosted proxy timed out reaching ${jiraHost}. If this is an internal or VPN-only Jira, our servers can't see it — click "Override" above and use a local CORS proxy on your network.`;
		}
		if (status === 400) {
			return `The Hoursmith hosted proxy rejected the request for ${jiraHost}${proxyDetail ? `: ${proxyDetail}` : '.'}`;
		}
		if (status === 429) {
			return 'Too many requests through the hosted proxy. Please wait a moment and retry.';
		}
	}
	return describeJiraTestStatus(status, jiraHost);
}

/**
 * Fixed analytics enum for a Jira connection-test outcome (ADA — activation
 * funnel). Derived from the HTTP status / error *type*, never the raw message,
 * so no Jira-derived text (hosts, issue keys, JQL) can leak into analytics.
 */
type JiraTestFailureReason =
	| 'ok'
	| 'auth'
	| 'not_found'
	| 'cors'
	| 'timeout'
	| 'server'
	| 'email_mismatch'
	| 'unknown';

function jiraFailureReasonForStatus(status: number): JiraTestFailureReason {
	if (status === 401 || status === 403) return 'auth';
	if (status === 404) return 'not_found';
	if (status >= 500) return 'server';
	return 'unknown';
}

/** Coarse duration bucket for the connection test, benign for analytics. */
function durationBucket(ms: number): '<1s' | '1-3s' | '3-10s' | '>10s' {
	if (ms < 1000) return '<1s';
	if (ms < 3000) return '1-3s';
	if (ms < 10_000) return '3-10s';
	return '>10s';
}

const emptyTest: IntegrationTestResult = { loading: false, result: null };
const resetIntegrationTests = () => ({
	jira: { ...emptyTest },
	gitlab: { ...emptyTest },
	github: { ...emptyTest },
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

		// Track the test wall-clock from the very start so the `jira_connection_tested`
		// analytics event (the connect success-rate metric) has a duration bucket on
		// every outcome path — including failures thrown before the inner timing.
		const testStartedAt = performance.now();
		// HTTP status of the `/myself` probe, captured so the catch path can map it to
		// a fixed failure-reason enum (the thrown Error only carries a redacted message).
		let myselfStatus = 0;

		try {
			const { formData } = get();
			const normalizedConfig = normalizeConfig(formData);

			const host = normalizedConfig.corsProxy
				? `${normalizedConfig.corsProxy.replace(/\/$/, '')}/https://${normalizedConfig.jiraHost}`
				: `https://${normalizedConfig.jiraHost}`;

			// The active gateway. In `hosted` mode the request goes to the Hoursmith
			// proxy regardless of `corsProxy`, so error/timeout copy must NOT use the
			// `host` label above (it would show the stale pre-rewrite proxy URL) — it
			// names the Jira host instead (ADA-523).
			const mode = getJiraGatewayMode(normalizedConfig.corsProxy);

			// Human-readable label for timeout messages — the hosted proxy in hosted
			// mode, the self-configured proxy if one is set, else the Jira host (ADA-444).
			const timeoutHostLabel =
				mode === 'hosted'
					? 'the Hoursmith hosted proxy'
					: normalizedConfig.corsProxy
						? `${normalizedConfig.corsProxy.replace(/\/$/, '')} (proxy)`
						: normalizedConfig.jiraHost;

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
			const myselfRes = await fetchWithTimeout(
				myselfReq.url,
				{ headers: myselfReq.headers },
				JIRA_TEST_TIMEOUT_MS,
				timeoutHostLabel,
			);
			myselfStatus = myselfRes.status;
			if (!myselfRes.ok) {
				throw new JiraTestError(
					await describeJiraTestFailure(
						myselfRes,
						mode,
						normalizedConfig.jiraHost,
					),
				);
			}
			const myself = (await myselfRes.json()) as {
				displayName?: string;
				emailAddress?: string;
			};
			const duration = Math.round(performance.now() - startTime);
			logger.debug(`[Test] Jira OK in ${duration}ms: ${myself.displayName}`);

			// ADA-436: My Week filters by the Settings email. If the token belongs to
			// a different account than `config.email`, My Week will silently show
			// nothing — warn the user instead of reporting a clean success.
			const tokenEmail = myself.emailAddress?.trim() ?? '';
			const settingsEmail = normalizedConfig.email.trim();
			const emailMismatch =
				!!tokenEmail &&
				!!settingsEmail &&
				tokenEmail.toLowerCase() !== settingsEmail.toLowerCase();

			// Auto-detect worklog permissions
			try {
				const permsReq = jiraReq(
					`${host}/rest/api/2/mypermissions?permissions=WORK_ON_ISSUES,EDIT_ALL_WORKLOGS,EDIT_OWN_WORKLOGS,DELETE_ALL_WORKLOGS,DELETE_OWN_WORKLOGS`,
				);
				const permsRes = await fetchWithTimeout(
					permsReq.url,
					{ headers: permsReq.headers },
					JIRA_TEST_TIMEOUT_MS,
					timeoutHostLabel,
				);
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

			if (emailMismatch) {
				// Connection authenticated, but the token's account != Settings email.
				// Report as a failure so it isn't treated as verified evidence and the
				// user is steered to fix the email (ADA-436).
				trackEvent('jira_connection_tested', {
					result: 'failure',
					failure_reason: 'email_mismatch',
					http_status: myselfStatus,
					duration_bucket: durationBucket(performance.now() - testStartedAt),
				});
				set((s) => ({
					integrationTests: {
						...s.integrationTests,
						jira: {
							loading: false,
							result: {
								success: false,
								message: `Token belongs to ${tokenEmail} but Settings email is ${settingsEmail} — My Week filters by Settings email, so it may show nothing. Update the email to match.`,
							},
						},
					},
				}));
				return;
			}

			trackEvent('jira_connection_tested', {
				result: 'success',
				failure_reason: 'ok',
				http_status: myselfStatus,
				duration_bucket: durationBucket(performance.now() - testStartedAt),
			});
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
			const rawMessage =
				error instanceof Error ? error.message : 'Connection failed';
			// A JiraTestError already carries a user-ready message (status/proxy based),
			// so skip the CORS/network heuristics — they'd misread copy that mentions
			// "CORS proxy" as a browser CORS failure (ADA-523).
			const isComposed = error instanceof JiraTestError;
			const isCorsFailure =
				!isComposed &&
				(error instanceof TypeError ||
					/failed to fetch|networkerror|load failed|cors/i.test(rawMessage));
			const message =
				error instanceof TestTimeoutError
					? `No response from ${error.host} within ${JIRA_TEST_TIMEOUT_MS / 1000}s — check the proxy is running / the host is reachable.`
					: isComposed
						? rawMessage
						: isCorsFailure
							? 'Your browser blocked direct access to Jira (CORS). Configure a CORS proxy in Settings, or use the hosted proxy.'
							: rawMessage;
			// Map the failure to the fixed enum from the error *type* / captured HTTP
			// status — never the raw message — so no Jira-derived text reaches analytics.
			const failureReason: JiraTestFailureReason =
				error instanceof TestTimeoutError
					? 'timeout'
					: isCorsFailure
						? 'cors'
						: myselfStatus >= 400
							? jiraFailureReasonForStatus(myselfStatus)
							: 'unknown';
			trackEvent('jira_connection_tested', {
				result: 'failure',
				failure_reason: failureReason,
				http_status: myselfStatus,
				duration_bucket: durationBucket(performance.now() - testStartedAt),
			});
			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					jira: {
						loading: false,
						result: {
							success: false,
							message,
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

	testGithub: async () => {
		set((s) => ({
			integrationTests: {
				...s.integrationTests,
				github: { loading: true, result: null },
			},
		}));
		try {
			const { formData } = get();
			const normalizedConfig = normalizeConfig(formData);
			if (!normalizedConfig.githubToken) {
				throw new Error('GitHub token is required');
			}
			const token = normalizedConfig.githubToken;
			const host = normalizedConfig.githubHost;

			// Validate token + identity (throws ServiceError with friendly copy).
			const user = await fetchGithubUser(token, host, '');

			// Coverage preview: how many of this week's events carry Jira keys.
			const today = toLocalDateString(new Date());
			const weekAgo = toLocalDateString(
				new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
			);
			const suggestions = await fetchGithubSuggestions(
				token,
				host,
				'',
				weekAgo,
				today,
			);
			const keyed = suggestions.length;
			const sample = suggestions
				.slice(0, 3)
				.map((s) => s.issueKey)
				.join(', ');

			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					github: {
						loading: false,
						result: {
							success: true,
							message:
								keyed > 0
									? `Connected as @${user.login} — ${keyed} issue${keyed > 1 ? 's' : ''} with Jira-keyed activity this week (e.g. ${sample}).`
									: `Connected as @${user.login} — no Jira-keyed GitHub activity found this week. dev-panel links may still produce suggestions.`,
						},
					},
				},
			}));
		} catch (error) {
			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					github: {
						loading: false,
						result: {
							success: false,
							message:
								error instanceof Error ? error.message : 'GitHub connection failed',
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
			// Key is added by the gateway (header in hosted mode, query param
			// otherwise) — never include it here.
			const params = new URLSearchParams({
				perspective: 'interval',
				restrict_kind: 'activity',
				resolution_time: 'day',
				restrict_begin: today,
				restrict_end: today,
				format: 'json',
			});

			// RescueTime sends no CORS headers, so the browser can only read it
			// through *some* server: our hosted relay (Premium) or the user's own
			// CORS proxy. With neither, the request would hit rescuetime.com directly
			// and CORS-fail with an opaque `TypeError` — fail fast with actionable
			// copy instead, and never issue the doomed request.
			const mode = getRescueTimeGatewayMode(normalizedConfig.corsProxy);
			if (mode === 'direct') {
				throw new Error(
					"RescueTime can't be reached directly from the browser. Add a CORS proxy URL in Connection settings, then test again.",
				);
			}

			// NOTE: `url`/`requestHeaders` may carry the API key (see
			// rescueTimeService.ts SECURITY note). Never surface them in UI/log copy.
			const { url, headers: requestHeaders } = buildRescueTimeRequest(
				normalizedConfig.rescueTimeApiKey,
				normalizedConfig.corsProxy,
				params,
			);
			const target =
				mode === 'hosted'
					? 'the Hoursmith proxy'
					: `the CORS proxy (${normalizedConfig.corsProxy.replace(/\/$/, '')})`;

			let res: Response;
			try {
				res = await fetch(url, { headers: requestHeaders });
			} catch (cause) {
				// fetch rejects with a TypeError on network / CORS failure. The raw
				// message can embed the request URL (and thus the API key), so we must
				// not propagate it. Reference only the safe target description.
				throw new Error(
					`Could not reach RescueTime through ${target}. Check that it is running and reachable.`,
					{ cause },
				);
			}
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
