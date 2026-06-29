import { buildJiraRequest } from './jiraSearch';
import { fromHttpResponse, fromNetworkError } from './serviceErrors';

export interface IdentityConfig {
	jiraHost: string;
	email: string;
	apiToken: string;
	corsProxy: string;
}

const cache = new Map<string, string>();

/** Test-only: clear the session accountId cache. */
export function __resetIdentityCache(): void {
	cache.clear();
}

/**
 * The current user's Jira `accountId`. Tempo filters worklogs by accountId, not
 * email, so this is the email→accountId bridge. Cached per `email@host` for the
 * session (accountId is stable).
 */
export async function resolveAccountId(
	config: IdentityConfig,
	signal?: AbortSignal,
): Promise<string> {
	const key = `${config.email.toLowerCase()}@${config.jiraHost}`;
	const hit = cache.get(key);
	if (hit) return hit;

	const { url, headers } = buildJiraRequest(config, '/rest/api/2/myself');
	let res: Response;
	try {
		res = await fetch(url, { headers, signal });
	} catch (err) {
		throw fromNetworkError('Jira myself', err);
	}
	if (!res.ok) throw fromHttpResponse('Jira myself', res.status);
	const body = (await res.json()) as { accountId?: string };
	if (!body.accountId) {
		throw fromHttpResponse('Jira myself', 500, 'no accountId in response');
	}
	cache.set(key, body.accountId);
	return body.accountId;
}
