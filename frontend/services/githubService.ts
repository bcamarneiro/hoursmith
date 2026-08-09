import type { WorklogSuggestion } from '../../types/Suggestion';
import { fromRichMessage, fromNetworkError, ServiceError } from './serviceErrors';

// Reuse the same Jira key regex from gitlabService — left-boundary-anchored
// to avoid extracting `PROJ-5` from a longer token like `XPROJ-5`.
const JIRA_KEY_RE = /(?<![A-Z0-9])([A-Z][A-Z0-9]*-\d+)/g;

/** Shape returned by the GitHub Search Commits API per item. */
export interface GitHubCommitItem {
	sha: string;
	commit: {
		message: string;
		author: {
			name: string;
			email: string;
			date: string;
		};
	};
	html_url: string;
	repository?: {
		full_name: string;
	};
}

/** Top-level shape of the GitHub Search Commits API response. */
interface GitHubSearchResponse {
	total_count: number;
	incomplete_results: boolean;
	items: GitHubCommitItem[];
}

function extractJiraKeys(text: string): string[] {
	const matches = text.match(JIRA_KEY_RE);
	return matches ? [...new Set(matches)] : [];
}

function dateOnly(iso: string): string {
	return iso.slice(0, 10);
}

async function describeGithubErrorResponse(res: Response): Promise<string> {
	let detail = '';
	try {
		const body = (await res.text()).trim();
		if (body) {
			detail = body.length > 160 ? `${body.slice(0, 157)}...` : body;
		}
	} catch {
		// ignore body parse failures
	}

	if (res.status === 401) {
		return `GitHub rejected the token (401). Check that the token is still active and has the appropriate scopes (repo or read:user).`;
	}

	if (res.status === 403) {
		if (detail.includes('rate limit')) {
			return `GitHub API rate limit exceeded (403). ${detail.slice(0, 120)}`;
		}
		return `GitHub accepted the request but denied access (403). Check token scopes (repo for private repos, read:user for public).`;
	}

	if (res.status === 422) {
		return `GitHub could not process the query (422). Check the search parameters. ${detail}`;
	}

	return detail
		? `GitHub API error: ${res.status}. ${detail}`
		: `GitHub API error: ${res.status}.`;
}

function describeGithubConnectionError(error: unknown): string {
	if (
		error instanceof TypeError ||
		(error instanceof Error && /fetch|network/i.test(error.message))
	) {
		return `Could not reach api.github.com. Check your network connection, VPN, or CORS proxy configuration.`;
	}

	return error instanceof Error ? error.message : 'GitHub connection failed';
}

/** Estimate seconds per commit — floor at 30m, cap at 4h per day per key. */
function estimateSeconds(count: number): number {
	const min = 30 * 60;
	const perUnit = 3600;
	const max = 4 * 3600;
	return Math.min(Math.max(Math.round(count * perUnit), min), max);
}

function estimateConfidence(count: number): 'high' | 'medium' | 'low' {
	if (count >= 3) return 'high';
	if (count > 0) return 'medium';
	return 'low';
}

/** Extract the first line of a commit message for human-readable summaries. */
function firstLine(message: string): string {
	const idx = message.indexOf('\n');
	return idx === -1 ? message : message.slice(0, idx);
}

/**
 * Fetch the user's commits from GitHub's Search Commits API within a
 * date range and extract Jira issue keys to build worklog suggestions.
 *
 * Uses the user's email to identify commits via
 * `GET /search/commits?q=author-email:{email}+committer-date:{from}..{to}`.
 *
 * Requires a GitHub Personal Access Token with `read:user` (public repos)
 * or `repo` (private repos) scope, and the special
 * `application/vnd.github.cloak-preview` media type header.
 */
export async function fetchGithubSuggestions(
	githubToken: string,
	githubEmail: string,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<WorklogSuggestion[]> {
	if (!githubToken || !githubEmail) return [];

	const perPage = 100;
	const maxPages = 10;
	const allCommits: GitHubCommitItem[] = [];

	for (let page = 1; page <= maxPages; page++) {
		// Build search query: commits by this author email in the date range
		const q = `author-email:${githubEmail}+committer-date:${weekStart}..${weekEnd}`;
		const url = `https://api.github.com/search/commits?q=${encodeURIComponent(q)}&sort=committer-date&order=desc&per_page=${perPage}&page=${page}`;

		let res: Response;
		try {
			res = await fetch(url, {
				headers: {
					Accept: 'application/vnd.github.cloak-preview',
					Authorization: `Bearer ${githubToken}`,
					'User-Agent': 'hoursmith',
				},
				signal,
			});
		} catch (error) {
			if (error instanceof ServiceError) throw error;
			if (error instanceof DOMException && error.name === 'AbortError') {
				throw error;
			}
			if (error instanceof Error && error.name === 'AbortError') throw error;
			throw fromNetworkError('GitHub', error);
		}

		if (!res.ok) {
			throw fromRichMessage(
				'GitHub',
				res.status,
				await describeGithubErrorResponse(res),
			);
		}

		const data = (await res.json()) as GitHubSearchResponse;
		allCommits.push(...data.items);
		if (data.items.length < perPage) break;
	}

	// Group commits by (date, issueKey) with fractional shares for multi-key commits
	const grouped = new Map<
		string,
		{ count: number; reasons: string[]; repoName?: string }
	>();

	for (const item of allCommits) {
		const day = dateOnly(item.commit.author.date);
		if (day < weekStart || day > weekEnd) continue;

		const keys = extractJiraKeys(item.commit.message);
		if (keys.length === 0) continue;

		const repoName = item.repository?.full_name;
		const msgFirstLine = firstLine(item.commit.message).slice(0, 80);

		// Distribute 1 commit equally across all referenced keys
		const sharePerKey = 1 / keys.length;

		for (const key of keys) {
			const mapKey = `${day}::${key}`;
			let entry = grouped.get(mapKey);
			if (!entry) {
				entry = { count: 0, reasons: [] };
				grouped.set(mapKey, entry);
			}
			entry.count += sharePerKey;
			if (entry.reasons.length < 3) {
				entry.reasons.push(
					repoName ? `${msgFirstLine} (${repoName})` : msgFirstLine,
				);
			}
		}
	}

	// Convert grouped entries to suggestions
	const suggestions: WorklogSuggestion[] = [];

	for (const [mapKey, entry] of grouped) {
		const [day, issueKey] = mapKey.split('::');
		const cappedSeconds = estimateSeconds(entry.count);
		const hours = cappedSeconds / 3600;

		suggestions.push({
			id: `github-${issueKey}-${day}`,
			source: 'github',
			issueKey,
			date: day,
			suggestedTimeSpent:
				hours >= 1
					? `${Math.floor(hours)}h${hours % 1 >= 0.5 ? ' 30m' : ''}`
					: '30m',
			suggestedSeconds: cappedSeconds,
			confidence: estimateConfidence(entry.count),
			reason: entry.reasons.slice(0, 2).join('; '),
			logged: false,
		});
	}

	return suggestions;
}

export { extractJiraKeys, JIRA_KEY_RE };
