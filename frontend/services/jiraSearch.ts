/**
 * Shared Jira issue-search seam.
 *
 * Atlassian Cloud removed the classic `/rest/api/2/search` endpoint
 * (CHANGE-2046) — it now 410s with "migrate to /rest/api/3/search/jql". The
 * replacement is cursor-paginated:
 *
 *   GET ${base}/rest/api/3/search/jql?jql=…&maxResults=…&fields=…&nextPageToken=…
 *   → { issues: [{key, fields}], nextPageToken?: string, isLast?: boolean }
 *
 * There is no `total` and no `startAt` on Cloud — you follow `nextPageToken`
 * until it is absent (or `isLast === true`).
 *
 * Only **search** changed on Cloud. Other v2 endpoints (issue, worklog, user,
 * myself, mypermissions, …) still work. Jira Server / Data Center still uses
 * the classic `/rest/api/2/search` with `startAt`/`total` offset pagination.
 *
 * This module branches on host: Cloud (`*.atlassian.net`) → v3 cursor search;
 * everything else → v2 offset search. Call sites keep their JQL, fields and
 * downstream processing identical — only the search/pagination mechanism moves
 * here.
 *
 * Linear: ADA-383.
 */

import { rewriteForHostedProxy } from './jiraGateway';
import { fromHttpResponseAsync } from './serviceErrors';

/**
 * The slice of connection config the search seam needs. A structural subset of
 * the app `Config` so callers that hold a narrower shape (e.g.
 * `WorklogFetchConfig`) can pass it directly.
 */
export interface JiraSearchConfig {
	jiraHost: string;
	apiToken: string;
	email: string;
	corsProxy: string;
}

/**
 * True when the host is an Atlassian Cloud site (`*.atlassian.net`). Tolerates
 * a leading scheme and any trailing path/query so callers can pass either a
 * bare host or a fuller URL.
 */
export function isCloudJira(jiraHost: string): boolean {
	if (!jiraHost) return false;
	const host = jiraHost
		.replace(/^https?:\/\//i, '')
		.replace(/[/?#].*$/, '')
		.replace(/\/+$/, '');
	return /\.atlassian\.net$/i.test(host);
}

/** Mirror of the per-service `buildBaseUrl` (corsProxy prefix logic). */
function buildSearchBaseUrl(config: JiraSearchConfig): string {
	return config.corsProxy
		? `${config.corsProxy.replace(/\/$/, '')}/https://${config.jiraHost}`
		: `https://${config.jiraHost}`;
}

const SEARCH_HEADERS = (apiToken: string): Record<string, string> => ({
	Authorization: `Bearer ${apiToken}`,
	Accept: 'application/json',
	'X-Atlassian-Token': 'no-check',
});

/**
 * Build an authenticated, proxy-aware URL+headers pair for an arbitrary Jira
 * REST path. Reuses the same base-URL construction, auth headers, and
 * hosted-proxy rewrite that `fetchSearchPage` uses — so dev-status and other
 * non-search endpoints travel the identical authed/proxied path.
 */
export function buildJiraRequest(
	config: JiraSearchConfig,
	path: string,
): { url: string; headers: Record<string, string> } {
	const base = buildSearchBaseUrl(config);
	const headers = SEARCH_HEADERS(config.apiToken);
	const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
	return rewriteForHostedProxy(url, headers, {
		jiraHost: config.jiraHost,
		email: config.email,
		apiToken: config.apiToken,
	});
}

export interface SearchPageParams {
	jql: string;
	fields: string;
	maxResults: number;
	/** Server/DC offset pagination cursor. Ignored on Cloud. */
	startAt?: number;
	/** Cloud cursor token (from a previous page). Ignored on Server/DC. */
	nextPageToken?: string;
	/** Optional extra query params (e.g. `expand=changelog`). */
	expand?: string;
}

export interface SearchPageResult<T = unknown> {
	issues: T[];
	/** Present on Server/DC only. Undefined on Cloud (cursor pagination). */
	total?: number;
	/** Present on Cloud only — the cursor for the next page, if any. */
	nextPageToken?: string;
}

/**
 * Fetch a single page of issues. Builds the Cloud (v3 `search/jql`, cursor) or
 * Server (v2 `search`, startAt) URL based on the host, routes through the
 * hosted-proxy seam, and normalises the response.
 */
export async function fetchSearchPage<T = unknown>(
	config: JiraSearchConfig,
	params: SearchPageParams,
	signal?: AbortSignal,
): Promise<SearchPageResult<T>> {
	const base = buildSearchBaseUrl(config);
	const headers = SEARCH_HEADERS(config.apiToken);
	const cloud = isCloudJira(config.jiraHost);

	const query = new URLSearchParams();
	query.set('jql', params.jql);
	query.set('maxResults', String(params.maxResults));
	query.set('fields', params.fields);
	if (params.expand) query.set('expand', params.expand);

	let url: string;
	if (cloud) {
		if (params.nextPageToken) {
			query.set('nextPageToken', params.nextPageToken);
		}
		url = `${base}/rest/api/3/search/jql?${query.toString()}`;
	} else {
		query.set('startAt', String(params.startAt ?? 0));
		url = `${base}/rest/api/2/search?${query.toString()}`;
	}

	const rewritten = rewriteForHostedProxy(url, headers, {
		jiraHost: config.jiraHost,
		email: config.email,
		apiToken: config.apiToken,
	});
	const res = await fetch(rewritten.url, {
		headers: rewritten.headers,
		signal,
	});
	// On 401/403 the hosted proxy returns an entitlement code in the body — read
	// it so the UI can distinguish "Hoursmith session expired" from "bad Jira
	// token" (ADA-475). A genuine Jira 401 (direct/self-host) has no code.
	if (!res.ok) throw await fromHttpResponseAsync('Jira search', res);

	const data = (await res.json()) as {
		issues?: T[];
		total?: number;
		nextPageToken?: string;
		isLast?: boolean;
	};

	const issues = data.issues ?? [];
	if (cloud) {
		// On Cloud there is no `total`; pagination is cursor-based. When the page
		// is the last one, suppress the token so callers stop.
		const nextPageToken = data.isLast ? undefined : data.nextPageToken;
		return { issues, nextPageToken };
	}
	return { issues, total: data.total };
}

export interface SearchAllParams {
	jql: string;
	fields: string;
	maxResults?: number;
	/** Optional extra query params (e.g. `expand=changelog`). */
	expand?: string;
}

export interface SearchAllOptions<T> {
	signal?: AbortSignal;
	onPage?: (pageIssues: T[], info: { fetched: number; total?: number }) => void;
}

/**
 * Fetch every page of issues for a JQL query.
 *
 * - **Cloud**: follows `nextPageToken` until it is absent.
 * - **Server/DC**: advances `startAt` by `maxResults` until `issues.length >=
 *   total` (or an empty page is returned).
 *
 * Calls `onPage` after each page (with the running `fetched` count and, on
 * Server, the `total`).
 *
 * Cancellation (ADA-456): an aborted signal throws an `AbortError` rather than
 * returning a truncated list — a partial result must never be presented as a
 * complete one. Callers that want a clean cancel can detect `name ===
 * 'AbortError'`.
 */
export async function searchAllIssues<T = unknown>(
	config: JiraSearchConfig,
	{ jql, fields, maxResults = 100, expand }: SearchAllParams,
	opts?: SearchAllOptions<T>,
): Promise<T[]> {
	const cloud = isCloudJira(config.jiraHost);
	const all: T[] = [];

	let startAt = 0;
	let nextPageToken: string | undefined;

	while (true) {
		if (opts?.signal?.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}

		const page = await fetchSearchPage<T>(
			config,
			{
				jql,
				fields,
				maxResults,
				expand,
				startAt: cloud ? undefined : startAt,
				nextPageToken: cloud ? nextPageToken : undefined,
			},
			opts?.signal,
		);

		for (const issue of page.issues) all.push(issue);

		opts?.onPage?.(page.issues, { fetched: all.length, total: page.total });

		if (cloud) {
			if (!page.nextPageToken) break;
			nextPageToken = page.nextPageToken;
		} else {
			// Server/DC offset pagination. An empty or short page always means the
			// end. Only trust the `total`-based break when `total` was actually
			// present in the response — a Server that omits `total` must NOT be
			// treated as `total = 0` (that would silently drop every page after
			// the first). When `total` is absent, keep paging until a short/empty
			// page signals the end. (ADA-456)
			if (page.issues.length === 0) break;
			if (page.total !== undefined && all.length >= page.total) break;
			if (page.issues.length < maxResults) break;
			startAt += maxResults;
		}
	}

	return all;
}
