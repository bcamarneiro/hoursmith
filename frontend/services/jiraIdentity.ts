import { buildJiraRequest } from './jiraSearch';
import { fromHttpResponse, fromNetworkError } from './serviceErrors';

export interface IdentityConfig {
	jiraHost: string;
	email: string;
	apiToken: string;
	corsProxy: string;
}

export interface JiraIdentity {
	accountId: string;
	displayName: string;
}

const cache = new Map<string, JiraIdentity>();

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
	return (await resolveIdentity(config, signal)).accountId;
}

/**
 * The current user's `accountId` **and** `displayName`.
 *
 * The display name matters more than it looks: `deriveMonthlyReportState` drops
 * any worklog whose author has none, so a Tempo row without one disappears from
 * Reports silently.
 */
export async function resolveIdentity(
	config: IdentityConfig,
	signal?: AbortSignal,
): Promise<JiraIdentity> {
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
	const body = (await res.json()) as {
		accountId?: string;
		displayName?: string;
	};
	if (!body.accountId) {
		throw fromHttpResponse('Jira myself', 500, 'no accountId in response');
	}
	const identity: JiraIdentity = {
		accountId: body.accountId,
		displayName: body.displayName ?? '',
	};
	cache.set(key, identity);
	return identity;
}
