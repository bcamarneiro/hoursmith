import type { Config } from '../stores/useConfigStore';
import { fetchSearchPage } from './jiraSearch';

export interface JiraSearchResult {
	key: string;
	summary: string;
}

interface JiraSearchIssue {
	key: string;
	fields: { summary?: string };
}

export async function searchJiraIssues(
	config: Config,
	query: string,
	signal?: AbortSignal,
): Promise<JiraSearchResult[]> {
	if (!config.jiraHost || !config.apiToken || !query.trim()) return [];

	const trimmed = query.trim();

	// Build JQL: exact key match OR summary text search
	const jqlParts: string[] = [];

	// Check if the query looks like a Jira key (e.g., PROJ-123)
	const looksLikeKey = /^[A-Z][A-Z0-9]+-\d+$/i.test(trimmed);
	if (looksLikeKey) {
		jqlParts.push(`key = "${trimmed.toUpperCase()}"`);
	}

	jqlParts.push(`summary ~ "${trimmed}"`);

	const jql = jqlParts.join(' OR ');

	const { issues } = await fetchSearchPage<JiraSearchIssue>(
		config,
		{ jql, fields: 'key,summary', maxResults: 10 },
		signal,
	);

	return issues.map((issue) => ({
		key: issue.key,
		summary: issue.fields.summary ?? '',
	}));
}
