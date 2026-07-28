import type { EnrichedJiraWorklog, JiraIssue, JiraUser } from '../../types/jira';
import { buildJiraRequest } from './jiraSearch';
import { fromHttpResponse, fromNetworkError } from './serviceErrors';
import { searchAllIssues } from './jiraSearch';

export interface TempoWorklog {
	tempoWorklogId: number;
	jiraWorklogId?: number;
	// Verified 2026-06-26: Tempo v4 `issue` carries both `id` and `key`.
	issue: { id: number; key?: string };
	timeSpentSeconds: number;
	startDate: string;
	startTime?: string;
	description?: string;
	author?: { accountId?: string };
}

export function placeholderIssue(id: string, key?: string): JiraIssue {
	return {
		id,
		key: key ?? `UNKNOWN-${id}`,
		fields: { summary: `Unknown issue · ${key ?? id}` },
	};
}

/**
 * Map a Tempo worklog onto the app's `EnrichedJiraWorklog`. The day basis is
 * Tempo's `startDate` (already the worker's wall clock); `started` is synthesized
 * only so `worklogMonth()`/`new Date()` consumers keep working.
 *
 * `authorMap` lets callers supply per-worklog author info (team reads) or fall
 * back to a single user's email (current-user reads). When the map is provided,
 * the author's `emailAddress` and `displayName` come from the resolved Jira user;
 * when it's absent, `fallbackEmail` is used for backward compatibility.
 */
export function mapTempoWorklog(
	wl: TempoWorklog,
	issueMap: Map<string, JiraIssue>,
	fallbackEmailOrAuthorMap: string | Map<string, JiraUser>,
): EnrichedJiraWorklog {
	const issueId = String(wl.issue.id);
	const issue =
		issueMap.get(issueId) ?? placeholderIssue(issueId, wl.issue.key);
	const started = `${wl.startDate}T${wl.startTime ?? '00:00:00'}`;

	let author: JiraUser;
	if (typeof fallbackEmailOrAuthorMap === 'string') {
		author = { accountId: wl.author?.accountId, emailAddress: fallbackEmailOrAuthorMap };
	} else {
		const resolved = wl.author?.accountId
			? fallbackEmailOrAuthorMap.get(wl.author.accountId)
			: undefined;
		author = {
			accountId: wl.author?.accountId,
			emailAddress: resolved?.emailAddress,
			displayName: resolved?.displayName,
		};
	}

	return {
		id: String(wl.tempoWorklogId),
		issueId,
		started,
		created: started,
		timeSpentSeconds: wl.timeSpentSeconds,
		comment: wl.description ?? '',
		author,
		issue,
	};
}

interface AuthorLookupConfig {
	jiraHost: string;
	email: string;
	apiToken: string;
	corsProxy: string;
}

/**
 * Resolve a set of Tempo `author.accountId` values to Jira user objects via
 * `/rest/api/3/user?accountId=…`. Returns a map keyed by accountId. Missing /
 * unauthorized lookups are silently omitted — the mapper falls back to
 * `emailAddress: undefined` for those worklogs, which is fine for display.
 */
export async function resolveAuthorMap(
	config: AuthorLookupConfig,
	accountIds: string[],
	signal?: AbortSignal,
): Promise<Map<string, JiraUser>> {
	const map = new Map<string, JiraUser>();
	const unique = [...new Set(accountIds.filter(Boolean))];
	if (unique.length === 0) return map;

	await Promise.all(
		unique.map(async (accountId) => {
			const { url, headers } = buildJiraRequest(
				config,
				`/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`,
			);
			try {
				const res = await fetch(url, { headers, signal });
				if (!res.ok) return; // skip unresolvable authors silently
				const user = (await res.json()) as JiraUser;
				map.set(accountId, user);
			} catch {
				// network error on a single user lookup — skip, don't fail the batch
			}
		}),
	);
	return map;
}

export function chunkIds(ids: string[], size: number): string[][] {
	const out: string[][] = [];
	for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
	return out;
}

/**
 * Fetch Jira issue metadata for the given numeric issue ids, in chunks of 100 to
 * stay under JQL/URL limits. Missing issues are simply absent from the map; the
 * mapper substitutes a placeholder so the worklog is never dropped.
 */
export async function fetchIssueMetadata(
	ids: string[],
	config: Parameters<typeof searchAllIssues>[0],
	signal?: AbortSignal,
): Promise<Map<string, JiraIssue>> {
	const map = new Map<string, JiraIssue>();
	for (const chunk of chunkIds([...new Set(ids)], 100)) {
		if (chunk.length === 0) continue;
		const jql = `issue in (${chunk.join(',')})`;
		const issues = await searchAllIssues<JiraIssue>(
			config,
			{
				jql,
				fields: 'key,summary,issuetype,parent,project,status',
				maxResults: 100,
			},
			{ signal },
		);
		for (const issue of issues) map.set(String(issue.id), issue);
	}
	return map;
}
