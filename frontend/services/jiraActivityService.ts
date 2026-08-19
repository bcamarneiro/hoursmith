import type { WorklogSuggestion } from '../../types/Suggestion';
import type { Config } from '../stores/useConfigStore';
import { searchAllIssues } from './jiraSearch';

const JIRA_KEY_RE = /([A-Z][A-Z0-9]+-\d+)/;

interface JiraChangelog {
	histories: {
		created: string;
		author: { emailAddress?: string; displayName?: string };
		items: { field: string; fromString?: string; toString?: string }[];
	}[];
}

interface JiraIssueWithChangelog {
	id: string;
	key: string;
	fields: { summary?: string };
	changelog?: JiraChangelog;
}

function dateOnly(iso: string): string {
	return iso.slice(0, 10);
}

/**
 * Fetch Jira issues the user interacted with during the given week,
 * then analyze changelogs to produce worklog suggestions.
 */
export async function fetchJiraActivitySuggestions(
	config: Config,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<WorklogSuggestion[]> {
	if (!config.jiraHost || !config.apiToken) return [];

	// Two reaches, deliberately unioned:
	//   - assignee / worklog-author: tickets that are *yours*.
	//   - status CHANGED BY currentUser(): tickets you *moved*, whoever owns
	//     them. Leads and reviewers spend much of the week here, and the first
	//     clause alone cannot see any of it.
	// Measured on a live instance for one week: the first clause returned 1
	// issue, the union returned 4 — matching what Tempo's own calendar showed
	// for the same days.
	const jql =
		`((assignee = currentUser() OR worklogAuthor = currentUser())` +
		` AND updated >= "${weekStart}" AND updated <= "${weekEnd}")` +
		` OR (status CHANGED BY currentUser()` +
		// A bare end date means 00:00, so the final day of the range would be
		// excluded — verified live: DURING ("2026-08-05","2026-08-05") returns
		// nothing while the same day with 23:59 returns two issues. weekEnd is
		// inclusive everywhere else here, so it must be inclusive in the query.
		` DURING ("${weekStart}", "${weekEnd} 23:59"))` +
		// The page below is capped; without an order Jira decides which issues
		// survive truncation. Newest-first keeps the week's most recent work.
		` ORDER BY updated DESC`;
	// searchAllIssues paginates; fetchSearchPage returned a single page, so
	// raising the cap alone would only move the truncation point — and the
	// widened JQL above is exactly what makes a lead's week overflow it.
	const issues = await searchAllIssues<JiraIssueWithChangelog>(
		config,
		{ jql, fields: 'summary', maxResults: 100, expand: 'changelog' },
		{ signal },
	);

	const suggestions: WorklogSuggestion[] = [];

	const issueDetails = issues;

	const userEmail = config.email.toLowerCase();

	for (const issue of issueDetails) {
		if (!issue.changelog?.histories) continue;

		// Group activity by date
		const activityDays = new Map<
			string,
			{ transitions: number; comments: number; edits: number }
		>();

		for (const history of issue.changelog.histories) {
			const authorEmail = history.author?.emailAddress?.toLowerCase() ?? '';
			if (authorEmail !== userEmail) continue;

			const day = dateOnly(history.created);
			if (day < weekStart || day > weekEnd) continue;

			const existing = activityDays.get(day) || {
				transitions: 0,
				comments: 0,
				edits: 0,
			};

			for (const item of history.items) {
				if (item.field === 'status') {
					existing.transitions++;
				} else if (item.field === 'comment') {
					existing.comments++;
				} else {
					// Reassigning, re-pointing, editing a description or attaching a
					// file is work on the ticket. These already produced a suggestion
					// via the 30m floor below, but counted as nothing — so the reason
					// rendered blank and the user could not judge the suggestion.
					existing.edits++;
				}
			}

			activityDays.set(day, existing);
		}

		for (const [day, activity] of activityDays) {
			// Estimate: 1h per transition, 30m per comment, min 30m
			const estimatedSeconds = Math.max(
				1800,
				activity.transitions * 3600 + activity.comments * 1800,
			);
			const hours = estimatedSeconds / 3600;
			const timeSpent =
				hours >= 1
					? `${Math.floor(hours)}h${estimatedSeconds % 3600 > 0 ? ` ${Math.round((estimatedSeconds % 3600) / 60)}m` : ''}`
					: `${Math.round(estimatedSeconds / 60)}m`;

			suggestions.push({
				id: `jira-${issue.key}-${day}`,
				source: 'jira-activity',
				issueKey: issue.key,
				issueSummary: issue.fields.summary,
				date: day,
				suggestedTimeSpent: timeSpent,
				suggestedSeconds: estimatedSeconds,
				confidence: activity.transitions > 0 ? 'medium' : 'low',
				reason: [
					activity.transitions > 0
						? `${activity.transitions} status change${activity.transitions > 1 ? 's' : ''}`
						: '',
					activity.transitions === 0 &&
					activity.comments === 0 &&
					activity.edits > 0
						? `${activity.edits} field edit${activity.edits > 1 ? 's' : ''}`
						: '',
					activity.comments > 0
						? `${activity.comments} comment${activity.comments > 1 ? 's' : ''}`
						: '',
				]
					.filter(Boolean)
					.join(', '),
				logged: false,
			});
		}
	}

	return suggestions;
}

export { JIRA_KEY_RE };
