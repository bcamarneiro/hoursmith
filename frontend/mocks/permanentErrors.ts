/**
 * Mock Permanent Error Service Layer (ADA-764).
 *
 * The app's mock backend (`frontend/mocks/handlers.ts`) only ever returns
 * success payloads, so error-path tests have to hand-roll `page.route()`
 * fulfill stubs or fight real network failures. This module is the single,
 * reliable way to make the mock backend fail on purpose: every request to an
 * affected endpoint gets the SAME permanent error, on EVERY attempt — it
 * never "recovers" mid-test, and it never touches the real network.
 *
 * Two ways to activate a scenario:
 *
 *   1. URL (E2E / dev): add `?mockError=<scenario-id>` to the page URL.
 *      `frontend/mocks/browser.ts` reads it at worker construction time and
 *      installs the scenario handlers BEFORE the success handlers, so the
 *      stub wins for every matching request.
 *
 *   2. Code (unit/component tests): call `createPermanentErrorHandlers()`
 *      and pass the result to `setupServer()`/`setupWorker()` directly.
 *
 * Error taxonomy mirrors `frontend/services/serviceErrors.ts` and
 * `frontend/services/retryClient.ts`: "permanent" means non-retryable /
 * deterministic — 401/403/404 client failures and network failures (the
 * retry client never retries these), plus persistent 5xx that keep failing
 * on every retry attempt so callers exercise their exhausted-retry path.
 * `kind` maps 1:1 to `ServiceErrorKind` so UI mappers (`describeServiceError`)
 * produce the exact user-facing copy the scenario is testing.
 */
import { HttpResponse, http } from 'msw';
import type { HttpHandler, ResponseResolver } from 'msw';
import { logger } from '../react/utils/logger';

/** Query param that selects the active scenario, e.g. `?mockError=myself-401`. */
export const MOCK_ERROR_QUERY_PARAM = 'mockError';

export type PermanentErrorKind =
	| 'unauthorized'
	| 'forbidden'
	| 'not-found'
	| 'server-error'
	| 'network';

export interface PermanentErrorEndpoint {
	readonly method: 'get' | 'post' | 'put' | 'delete' | 'all';
	/** MSW path pattern — supports `*.atlassian.net` wildcards and `:params`. */
	readonly pattern: string;
}

export interface PermanentErrorScenario {
	/** Stable id used in `?mockError=<id>` and by tests. */
	readonly id: string;
	/** Human-readable purpose, for maintainers and test authors. */
	readonly description: string;
	/** Canonical HTTP status. 0 for `networkError` scenarios. */
	readonly status: number;
	/** Maps to `ServiceErrorKind` in `serviceErrors.ts`. */
	readonly kind: PermanentErrorKind;
	/** JSON body returned with the status. Jira-style when omitted. */
	readonly body?: unknown;
	/** True → simulate the fetch rejecting (network failure), not an HTTP status. */
	readonly networkError?: boolean;
	/** Endpoints that fail deterministically under this scenario. */
	readonly endpoints: readonly PermanentErrorEndpoint[];
}

/** Jira REST error shape (`errorMessages`) — what `describeJiraTestFailure` parses. */
function jiraErrorBody(message: string): { errorMessages: string[] } {
	return { errorMessages: [message] };
}

export const PERMANENT_ERROR_SCENARIOS: Readonly<
	Record<string, PermanentErrorScenario>
> = Object.freeze({
	'myself-401': {
		id: 'myself-401',
		description:
			'Connection probe (`GET /rest/api/2/myself`) → 401: Jira rejects the credentials.',
		status: 401,
		kind: 'unauthorized',
		body: jiraErrorBody('Unauthorized — your Jira email/API token was rejected.'),
		endpoints: [
			{ method: 'get', pattern: 'https://*.atlassian.net/rest/api/2/myself' },
		],
	},
	'myself-403': {
		id: 'myself-403',
		description:
			'Connection probe (`GET /rest/api/2/myself`) → 403: authenticated but denied.',
		status: 403,
		kind: 'forbidden',
		body: jiraErrorBody('Forbidden — your account lacks access to this Jira host.'),
		endpoints: [
			{ method: 'get', pattern: 'https://*.atlassian.net/rest/api/2/myself' },
		],
	},
	'myself-404': {
		id: 'myself-404',
		description:
			'Connection probe (`GET /rest/api/2/myself`) → 404: host not found.',
		status: 404,
		kind: 'not-found',
		body: jiraErrorBody('Not Found — confirm the Jira host name in Settings.'),
		endpoints: [
			{ method: 'get', pattern: 'https://*.atlassian.net/rest/api/2/myself' },
		],
	},
	'myself-network': {
		id: 'myself-network',
		description:
			'Connection probe (`GET /rest/api/2/myself`) rejects as a network failure — the fetch promise throws.',
		status: 0,
		kind: 'network',
		networkError: true,
		endpoints: [
			{ method: 'get', pattern: 'https://*.atlassian.net/rest/api/2/myself' },
		],
	},
	'search-500': {
		id: 'search-500',
		description:
			'Issue search (JQL) → 500 on every attempt: the dashboard surfacing its error/retry path.',
		status: 500,
		kind: 'server-error',
		body: jiraErrorBody('Internal Server Error — Jira is having problems.'),
		endpoints: [
			{ method: 'get', pattern: 'https://*.atlassian.net/rest/api/3/search/jql' },
			{ method: 'get', pattern: 'https://*.atlassian.net/rest/api/2/search' },
		],
	},
	'worklog-create-500': {
		id: 'worklog-create-500',
		description:
			'Worklog creation (`POST .../worklog`) → 500 on every attempt, including retries.',
		status: 500,
		kind: 'server-error',
		body: jiraErrorBody('Internal Server Error — the worklog was not saved.'),
		endpoints: [
			{
				method: 'post',
				pattern: 'https://*.atlassian.net/rest/api/2/issue/:issueKey/worklog',
			},
		],
	},
	'worklog-delete-403': {
		id: 'worklog-delete-403',
		description:
			'Worklog deletion (`DELETE .../worklog/:id`) → 403: permission denied.',
		status: 403,
		kind: 'forbidden',
		body: jiraErrorBody('Forbidden — you do not have permission to delete this worklog.'),
		endpoints: [
			{
				method: 'delete',
				pattern:
					'https://*.atlassian.net/rest/api/2/issue/:issueKey/worklog/:worklogId',
			},
		],
	},
});

/**
 * Build the MSW handlers for a scenario. Every matching request fails with
 * the same error — there is no success path, so retry loops exhaust and
 * callers deterministically hit their error branch.
 */
export function createPermanentErrorHandlers(
	scenario: PermanentErrorScenario,
): HttpHandler[] {
	return scenario.endpoints.map(({ method, pattern }) => {
		const resolver: ResponseResolver = ({ request }) => {
			logger.debug('[MSW] Permanent error stub:', {
				scenario: scenario.id,
				method: request.method,
				url: request.url,
			});
			if (scenario.networkError) {
				return HttpResponse.error();
			}
			return HttpResponse.json(scenario.body ?? jiraErrorBody('Permanent mock error.'), {
				status: scenario.status,
			});
		};

		switch (method) {
			case 'get':
				return http.get(pattern, resolver);
			case 'post':
				return http.post(pattern, resolver);
			case 'put':
				return http.put(pattern, resolver);
			case 'delete':
				return http.delete(pattern, resolver);
			case 'all':
				return http.all(pattern, resolver);
			default:
				throw new Error(`Unsupported endpoint method: ${method}`);
		}
	});
}

/**
 * Resolve the active scenario from a query string (defaults to the current
 * page URL). Returns `null` when no `mockError` param is present or the id
 * is unknown — callers then install no error stubs.
 */
export function getPermanentErrorScenario(
	search: string = typeof window !== 'undefined' ? window.location.search : '',
): PermanentErrorScenario | null {
	const id = new URLSearchParams(search).get(MOCK_ERROR_QUERY_PARAM);
	if (!id) return null;
	const scenario = PERMANENT_ERROR_SCENARIOS[id];
	if (!scenario) {
		logger.debug(`[MSW] Unknown permanent error scenario: "${id}"`);
		return null;
	}
	return scenario;
}
