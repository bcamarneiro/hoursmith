// frontend/services/devActivityService.ts
import type { WorklogSuggestion } from '../../types/Suggestion';
import type { Config } from '../stores/useConfigStore';
import { fetchSearchPage } from './jiraSearch';

export interface DevActivityUser {
	githubLogin?: string | null;
	displayName?: string | null;
}

interface IssueRef {
	id: string;
	key: string;
	fields?: { summary?: string };
}

interface DevCommit {
	displayId?: string;
	message?: string;
	authorTimestamp?: string;
	author?: { name?: string };
}

interface DevDetailResponse {
	detail?: { repositories?: { name?: string; commits?: DevCommit[] }[] }[];
}

interface DevSummaryResponse {
	summary?: Record<string, { overall?: { count?: number } }>;
}

const DEV_BASE = '/rest/dev-status/latest/issue';

function dateOnly(iso: string): string {
	return iso.slice(0, 10);
}

/** Case-insensitive match of a dev author name against the user's identities. */
function isCurrentUser(authorName: string | undefined, user: DevActivityUser): boolean {
	if (!authorName) return false;
	const candidates = [user.githubLogin, user.displayName]
		.filter((v): v is string => !!v)
		.map((v) => v.toLowerCase());
	if (candidates.length === 0) return false;
	return candidates.includes(authorName.toLowerCase());
}

/**
 * For each Jira issue the user touched this week, read GitHub commits linked via
 * Jira's dev-status API and attribute the user's own commits (in-window) as
 * worklog suggestions. dev-status is an unofficial Jira API and best-effort:
 * per-issue failures are swallowed, and an empty result is a valid outcome
 * (integration not connected). Goes through the existing Jira request path
 * (`fetchSearchPage` builds the base URL / headers / proxy via Jira config).
 */
export async function fetchDevActivitySuggestions(
	config: Config,
	weekStart: string,
	weekEnd: string,
	user: DevActivityUser,
	signal?: AbortSignal,
): Promise<WorklogSuggestion[]> {
	if (!config.jiraHost || !config.apiToken) return [];

	const jql = `(assignee = currentUser() OR worklogAuthor = currentUser()) AND updated >= "${weekStart}" AND updated <= "${weekEnd}"`;
	const { issues } = await fetchSearchPage<IssueRef>(
		config,
		{ jql, fields: 'summary', maxResults: 50 },
		signal,
	);

	// fetchSearchPage builds the proxied/authed Jira base; mirror its URL shape
	// for the dev-status calls. We reuse the same base by deriving it from a
	// lightweight helper exported there (see jiraSearch.buildBaseUrl) — but to
	// keep this service self-contained we call through a thin wrapper below.
	const { jiraRequest } = await import('./jiraRequest');

	const out: WorklogSuggestion[] = [];

	for (const issue of issues) {
		try {
			const summary = (await jiraRequest(
				config,
				`${DEV_BASE}/summary?issueId=${issue.id}`,
				signal,
			)) as DevSummaryResponse;
			const counts = Object.values(summary.summary ?? {}).map(
				(v) => v.overall?.count ?? 0,
			);
			if (!counts.some((c) => c > 0)) continue;

			const detail = (await jiraRequest(
				config,
				`${DEV_BASE}/detail?issueId=${issue.id}&applicationType=GitHub&dataType=repository`,
				signal,
			)) as DevDetailResponse;

			const commits = (detail.detail ?? []).flatMap((d) =>
				(d.repositories ?? []).flatMap((r) => r.commits ?? []),
			);

			const byDay = new Map<string, { count: number; reasons: string[] }>();
			for (const c of commits) {
				if (!isCurrentUser(c.author?.name, user)) continue;
				if (!c.authorTimestamp) continue;
				const day = dateOnly(c.authorTimestamp);
				if (day < weekStart || day > weekEnd) continue;
				const e = byDay.get(day) ?? { count: 0, reasons: [] };
				e.count += 1;
				if (c.message) e.reasons.push(c.message.slice(0, 80));
				byDay.set(day, e);
			}

			for (const [day, e] of byDay) {
				const capped = Math.min(e.count * 3600, 6 * 3600);
				const hours = capped / 3600;
				out.push({
					id: `github-${issue.key}-${day}`,
					source: 'github',
					issueKey: issue.key,
					date: day,
					suggestedTimeSpent:
						hours >= 1
							? `${Math.floor(hours)}h${hours % 1 >= 0.5 ? ' 30m' : ''}`
							: '30m',
					suggestedSeconds: capped,
					confidence: e.count >= 3 ? 'high' : 'medium',
					reason: `${e.count} linked commit${e.count > 1 ? 's' : ''}${
						e.reasons.length ? `: ${e.reasons.slice(0, 2).join('; ')}` : ''
					}`,
					logged: false,
				});
			}
		} catch {
			// Best-effort: skip this issue, keep going.
		}
	}

	return out;
}
