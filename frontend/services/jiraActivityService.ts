import type { WorklogSuggestion } from '../../types/Suggestion';
import type { Config } from '../stores/useConfigStore';
import type {
	JiraActivityItem,
	JiraIssueWithChangelog,
} from '../types/activity';
import { fetchSearchPage } from './jiraSearch';

const JIRA_KEY_RE = /([A-Z][A-Z0-9]+-\d+)/;

function dateOnly(iso: string): string {
	return iso.slice(0, 10);
}

/**
 * JQL used by the recent-activity fetch: issues the current user is assigned
 * to or has logged work against, updated within the requested window.
 */
export function jiraActivityJql(weekStart: string, weekEnd: string): string {
	return `(assignee = currentUser() OR worklogAuthor = currentUser()) AND updated >= "${weekStart}" AND updated <= "${weekEnd}"`;
}

/**
 * Fetch Jira issues the user interacted with during the given week and
 * normalize their changelogs into per-day activity records.
 *
 * Robustness: malformed histories (missing `created` or a non-array `items`)
 * are skipped rather than throwing, and entries from other authors are
 * filtered out — the service returns an empty array when Jira is not
 * configured instead of attempting a doomed fetch.
 *
 * @returns Activity items, ordered by issue (Jira response order), then by
 *   first-seen history date per issue.
 */
export async function fetchRecentActivity(
	config: Config,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<JiraActivityItem[]> {
	if (!config.jiraHost || !config.apiToken) return [];

	const { issues } = await fetchSearchPage<JiraIssueWithChangelog>(
		config,
		{
			jql: jiraActivityJql(weekStart, weekEnd),
			fields: 'summary',
			maxResults: 20,
			expand: 'changelog',
		},
		signal,
	);

	const userEmail = config.email.toLowerCase();
	const items: JiraActivityItem[] = [];

	for (const issue of issues) {
		if (!issue.changelog?.histories) continue;

		// Group activity by date (Map keeps first-seen insertion order).
		const activityDays = new Map<
			string,
			{ transitions: number; comments: number }
		>();

		for (const history of issue.changelog.histories) {
			const authorEmail = history.author?.emailAddress?.toLowerCase() ?? '';
			if (authorEmail !== userEmail) continue;

			const created = history.created;
			if (!created) continue;
			const day = dateOnly(created);
			if (day < weekStart || day > weekEnd) continue;

			// Malformed history payloads (missing/non-array `items`) are
			// skipped — one bad entry should not sink the whole fetch.
			if (!Array.isArray(history.items)) continue;

			const existing = activityDays.get(day) || {
				transitions: 0,
				comments: 0,
			};

			for (const item of history.items) {
				if (item.field === 'status') {
					existing.transitions++;
				} else if (item.field === 'comment') {
					existing.comments++;
				}
			}

			activityDays.set(day, existing);
		}

		for (const [day, activity] of activityDays) {
			items.push({
				issueKey: issue.key,
				issueSummary: issue.fields?.summary,
				date: day,
				transitions: activity.transitions,
				comments: activity.comments,
			});
		}
	}

	return items;
}

/**
 * Turn normalized activity items into worklog suggestions.
 *
 * Estimation rules: 1h per status transition, 30m per comment, floored at
 * 30m. Pure — takes the normalized `JiraActivityItem[]` contract, so callers
 * that already hold activity items (e.g. the dashboard fetcher reading the
 * shared query cache) can derive suggestions without re-fetching.
 */
export function jiraActivityItemsToSuggestions(
	items: JiraActivityItem[],
): WorklogSuggestion[] {
	return items.map((item) => {
		const estimatedSeconds = Math.max(
			1800,
			item.transitions * 3600 + item.comments * 1800,
		);
		const hours = estimatedSeconds / 3600;
		const timeSpent =
			hours >= 1
				? `${Math.floor(hours)}h${estimatedSeconds % 3600 > 0 ? ` ${Math.round((estimatedSeconds % 3600) / 60)}m` : ''}`
				: `${Math.round(estimatedSeconds / 60)}m`;

		return {
			id: `jira-${item.issueKey}-${item.date}`,
			source: 'jira-activity',
			issueKey: item.issueKey,
			issueSummary: item.issueSummary,
			date: item.date,
			suggestedTimeSpent: timeSpent,
			suggestedSeconds: estimatedSeconds,
			confidence: item.transitions > 0 ? 'medium' : 'low',
			reason: [
				item.transitions > 0
					? `${item.transitions} status change${item.transitions > 1 ? 's' : ''}`
					: '',
				item.comments > 0
					? `${item.comments} comment${item.comments > 1 ? 's' : ''}`
					: '',
			]
				.filter(Boolean)
				.join(', '),
			logged: false,
		};
	});
}

/**
 * Fetch Jira issues the user interacted with during the given week,
 * then turn the normalized activity into worklog suggestions.
 *
 * @see fetchRecentActivity for the fetch + normalization layer.
 */
export async function fetchJiraActivitySuggestions(
	config: Config,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<WorklogSuggestion[]> {
	const activityItems = await fetchRecentActivity(
		config,
		weekStart,
		weekEnd,
		signal,
	);

	return jiraActivityItemsToSuggestions(activityItems);
}

export { JIRA_KEY_RE };
