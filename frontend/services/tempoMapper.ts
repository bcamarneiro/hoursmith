import type { EnrichedJiraWorklog, JiraIssue } from '../../types/jira';
import { searchAllIssues } from './jiraSearch';

export interface TempoWorklog {
	tempoWorklogId: number;
	jiraWorklogId?: number;
	/**
	 * Corrected 2026-08-18 against a live Tempo instance: v4 `issue` carries
	 * `{ self, id }` ONLY — there is no `key`. An earlier comment here claimed
	 * otherwise. `key` stays optional in case some deployments include it, but
	 * the Jira metadata lookup in `fetchIssueMetadata` is REQUIRED, not an
	 * optimisation: without it every row renders as `UNKNOWN-<id>`.
	 */
	issue: { id: number; key?: string };
	timeSpentSeconds: number;
	startDate: string;
	startTime?: string;
	/**
	 * The same instant as `startDate` + `startTime`, but in UTC (e.g.
	 * `2026-07-27T08:00:00Z` for a 09:00 local start at +01:00). Tempo gives no
	 * offset on `startTime` itself, so this is the only way to recover the
	 * author's timezone — which `classifyWorklog` needs to compare `created`
	 * against `started` in one frame (ADA-457/463).
	 */
	startDateTimeUtc?: string;
	/** When the worklog was actually recorded — the basis for lateness. */
	createdAt?: string;
	updatedAt?: string;
	description?: string;
	author?: { accountId?: string };
}

/**
 * Recover the author's UTC offset by comparing the local wall clock against the
 * same instant in UTC, and render it as an ISO suffix (`+01:00`, `-03:00`, `Z`).
 * Returns `''` when Tempo omits `startDateTimeUtc` or either value is
 * unparseable, in which case the caller emits an offset-less timestamp and the
 * classifier falls back to plain wall-clock comparison.
 */
export function deriveOffsetSuffix(
	startDate: string,
	startTime: string,
	startDateTimeUtc: string | undefined,
): string {
	if (!startDateTimeUtc) return '';
	// Reading the local wall clock as though it were UTC makes the difference
	// between the two instants exactly the author's offset.
	const asIfUtc = Date.parse(`${startDate}T${startTime}Z`);
	const actualUtc = Date.parse(startDateTimeUtc);
	if (Number.isNaN(asIfUtc) || Number.isNaN(actualUtc)) return '';
	const minutes = Math.round((asIfUtc - actualUtc) / 60_000);
	if (minutes === 0) return 'Z';
	// Guard against a nonsense value from a malformed payload rather than
	// emitting a timestamp Date.parse would reject.
	if (Math.abs(minutes) > 14 * 60) return '';
	const sign = minutes < 0 ? '-' : '+';
	const abs = Math.abs(minutes);
	const hh = String(Math.floor(abs / 60)).padStart(2, '0');
	const mm = String(abs % 60).padStart(2, '0');
	return `${sign}${hh}:${mm}`;
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
 *
 * `created` maps from Tempo's `createdAt` — NOT from `started`. This previously
 * assigned `created = started`, which made `createdIso > startedIso` in
 * `classifyWorklog` permanently false: every Tempo worklog reported
 * `daysLate: 0` and `isBackdated: false`, silently disabling late-logging
 * detection on exactly the instances the integration exists to serve. Verified
 * against a live instance on 2026-08-18 (work 2026-07-27, logged 2026-08-05:
 * reported 0 days late, actually 9).
 */
export function mapTempoWorklog(
	wl: TempoWorklog,
	issueMap: Map<string, JiraIssue>,
	email: string,
): EnrichedJiraWorklog {
	const issueId = String(wl.issue.id);
	const issue =
		issueMap.get(issueId) ?? placeholderIssue(issueId, wl.issue.key);
	const startTime = wl.startTime ?? '00:00:00';
	const offset = deriveOffsetSuffix(
		wl.startDate,
		startTime,
		wl.startDateTimeUtc,
	);
	const started = `${wl.startDate}T${startTime}${offset}`;
	return {
		id: String(wl.tempoWorklogId),
		issueId,
		started,
		created: wl.createdAt ?? started,
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
