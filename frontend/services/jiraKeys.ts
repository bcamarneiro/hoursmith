// Match standard Jira issue keys (e.g. PROJ-12, A-1) while requiring a left
// boundary so we don't extract `PROJ-5` from a longer token like `XPROJ-5`.
// `[A-Z][A-Z0-9]*` allows single-letter project keys (`A-1`).
export const JIRA_KEY_RE = /(?<![A-Z0-9])([A-Z][A-Z0-9]*-\d+)/g;

export function extractJiraKeys(text: string): string[] {
	const matches = text.match(JIRA_KEY_RE);
	return matches ? [...new Set(matches)] : [];
}
