import type { EnrichedJiraWorklog, JiraIssue } from '../../types/jira';
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
 * only so `worklogMonth()`/`new Date()` consumers keep working. `author` is
 * synthesized with the current user's email so downstream email grouping works.
 */
export function mapTempoWorklog(
	wl: TempoWorklog,
	issueMap: Map<string, JiraIssue>,
	email: string,
): EnrichedJiraWorklog {
	const issueId = String(wl.issue.id);
	const issue =
		issueMap.get(issueId) ?? placeholderIssue(issueId, wl.issue.key);
	const started = `${wl.startDate}T${wl.startTime ?? '00:00:00'}`;
	return {
		id: String(wl.tempoWorklogId),
		issueId,
		started,
		created: started,
		timeSpentSeconds: wl.timeSpentSeconds,
		comment: wl.description ?? '',
		author: { accountId: wl.author?.accountId, emailAddress: email },
		issue,
	};
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
