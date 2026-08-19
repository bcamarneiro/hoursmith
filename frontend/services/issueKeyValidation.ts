/**
 * Keep only the issue keys Jira actually knows about.
 *
 * Branch names and commit messages contain text shaped like an issue key that
 * is not one. Two real examples from a live account:
 *
 *   - `APP-A-132/Bancontact-Integration` — a branch naming convention;
 *     `APP-A-132` 404s in Jira.
 *   - `WEB-000` — a placeholder used when no ticket applies.
 *
 * Neither is fixable by pattern alone. Widening the regex to admit the first
 * would admit every hyphenated branch prefix, and a hard-coded blocklist needs
 * a new entry for each convention a team invents. Jira is the one source that
 * knows which keys exist, and a single JQL answers for the whole batch.
 *
 * This filters *noise*, so a failed lookup keeps every candidate: hiding a
 * day's real activity because Jira was briefly unreachable is a worse outcome
 * than showing one suggestion that turns out to be bogus.
 */

import { searchAllIssues } from './jiraSearch';

/** Jira caps a JQL `IN` clause well above this; chunk to stay under URL limits. */
const CHUNK_SIZE = 100;

export async function filterToRealIssueKeys(
	config: Parameters<typeof searchAllIssues>[0],
	candidates: Iterable<string>,
	signal?: AbortSignal,
): Promise<Set<string>> {
	const unique = [...new Set([...candidates].filter(Boolean))];
	if (unique.length === 0) return new Set();

	const real = new Set<string>();
	try {
		for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
			const chunk = unique.slice(i, i + CHUNK_SIZE);
			const issues = await searchAllIssues<{ key?: string }>(
				config,
				{
					jql: `issue in (${chunk.map((k) => `"${k}"`).join(',')})`,
					fields: 'summary',
					maxResults: CHUNK_SIZE,
				},
				{ signal },
			);
			for (const issue of issues) {
				if (issue.key) real.add(issue.key);
			}
		}
	} catch {
		// Unreachable Jira must not erase the day's activity — see above.
		return new Set(unique);
	}
	return real;
}
