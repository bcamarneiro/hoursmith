// frontend/services/jiraRequest.ts
import type { Config } from '../stores/useConfigStore';
import { buildJiraRequest } from './jiraSearch';

/**
 * Issue an authenticated, proxy-aware GET against an arbitrary Jira REST path
 * (e.g. /rest/dev-status/...). Reuses jiraSearch's URL+header+hosted-proxy
 * construction so dev-status calls travel the exact same path as searches.
 */
export async function jiraRequest(
	config: Config,
	path: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const { url, headers } = buildJiraRequest(config, path);
	const res = await fetch(url, { headers, signal });
	if (!res.ok) throw new Error(`Jira request failed: ${res.status}`);
	return res.json();
}
