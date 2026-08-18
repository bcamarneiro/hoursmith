import type { EnrichedJiraWorklog } from '../../types/jira';
import { resolveAccountId } from './jiraIdentity';
import { jiraRequest } from './jiraRequest';
import { fromHttpResponse, fromNetworkError } from './serviceErrors';
import { buildTempoRequest } from './tempoGateway';
import {
	fetchIssueMetadata,
	mapTempoWorklog,
	type TempoWorklog,
} from './tempoMapper';
import type { WorklogEntry } from './worklogService';

export interface TempoServiceConfig {
	jiraHost: string;
	email: string;
	apiToken: string;
	corsProxy: string;
	tempoApiToken: string;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

interface TempoPage {
	results: TempoWorklog[];
	metadata?: { next?: string };
}

/**
 * Fetch every Tempo worklog for a range, following `metadata.next`.
 *
 * `accountId` selects the endpoint: a string scopes the read to that one user
 * (`worklogs/user/{id}`), while `null` uses the non-user-scoped `worklogs`
 * endpoint that returns the whole team (ADA-545). Verified against a live
 * instance 2026-08-18: the team endpoint needs no extra token scope.
 */
async function fetchAllTempoWorklogs(
	config: TempoServiceConfig,
	accountId: string | null,
	from: string,
	to: string,
	signal?: AbortSignal,
): Promise<TempoWorklog[]> {
	const all: TempoWorklog[] = [];
	let params: URLSearchParams | null = new URLSearchParams({
		from,
		to,
		limit: '1000',
	});
	let path = accountId === null ? 'worklogs' : `worklogs/user/${accountId}`;

	while (params) {
		const { url, headers } = buildTempoRequest(
			config.tempoApiToken,
			config.corsProxy,
			path,
			params,
		);
		let res: Response;
		try {
			res = await fetch(url, { headers, signal });
		} catch (err) {
			throw fromNetworkError('Tempo worklogs', err);
		}
		if (!res.ok) throw fromHttpResponse('Tempo worklogs', res.status);
		const page = (await res.json()) as TempoPage;
		all.push(...(page.results ?? []));

		const next = page.metadata?.next;
		if (!next) break;
		// `next` is an absolute api.tempo.io URL; re-extract path + query so the
		// gateway re-wraps it for the active mode rather than calling it raw.
		const u = new URL(next);
		path = u.pathname.replace(/^\/4\//, '');
		params = u.searchParams;
	}
	return all;
}

async function enrichAndMap(
	config: TempoServiceConfig,
	worklogs: TempoWorklog[],
	signal?: AbortSignal,
	emailByAccountId?: Map<string, string>,
): Promise<EnrichedJiraWorklog[]> {
	const ids = worklogs.map((w) => String(w.issue.id));
	const issueMap = await fetchIssueMetadata(ids, config, signal);
	return worklogs.map((w) => {
		// Personal reads are all the signed-in user, so config.email is right.
		// Team reads must not do that: the completeness table groups by email, so
		// stamping one address on every row would merge the whole team into one
		// person. Fall back to the accountId, which at least stays distinct.
		const accountId = w.author?.accountId;
		const email = emailByAccountId
			? accountId
				? (emailByAccountId.get(accountId) ?? accountId)
				: ''
			: config.email;
		return mapTempoWorklog(w, issueMap, email);
	});
}

/**
 * Resolve Jira emails for the given accountIds via `/rest/api/3/user/bulk`.
 *
 * Tempo identifies authors by accountId only, but every downstream grouping in
 * this app keys on email. Users whose email is hidden by Jira privacy settings
 * are simply absent from the result; the caller falls back to the accountId.
 */
export async function fetchEmailsByAccountId(
	config: TempoServiceConfig,
	accountIds: string[],
	signal?: AbortSignal,
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const unique = [...new Set(accountIds.filter(Boolean))];
	// Jira caps `/user/bulk` at 200 ids per call.
	for (let i = 0; i < unique.length; i += 200) {
		const chunk = unique.slice(i, i + 200);
		const query = chunk
			.map((id) => `accountId=${encodeURIComponent(id)}`)
			.join('&');
		try {
			const json = (await jiraRequest(
				config as unknown as Parameters<typeof jiraRequest>[0],
				`/rest/api/3/user/bulk?maxResults=200&${query}`,
				signal,
			)) as { values?: Array<{ accountId?: string; emailAddress?: string }> };
			for (const user of json.values ?? []) {
				if (user.accountId && user.emailAddress) {
					map.set(user.accountId, user.emailAddress);
				}
			}
		} catch {
			// A failed lookup degrades attribution to accountIds; it must not take
			// the whole team read down with it.
		}
	}
	return map;
}

export async function fetchMonthWorklogsTempo(
	config: TempoServiceConfig,
	year: number,
	month: number, // 0-indexed
	signal?: AbortSignal,
): Promise<EnrichedJiraWorklog[]> {
	if (!config.jiraHost || !config.apiToken || !config.tempoApiToken) return [];
	const accountId = await resolveAccountId(config, signal);
	const daysInMonth = new Date(year, month + 1, 0).getDate();
	const from = `${year}-${pad(month + 1)}-01`;
	const to = `${year}-${pad(month + 1)}-${pad(daysInMonth)}`;
	const worklogs = await fetchAllTempoWorklogs(
		config,
		accountId,
		from,
		to,
		signal,
	);
	return enrichAndMap(config, worklogs, signal);
}

/**
 * Month read covering the whole team (ADA-545). Unlike the per-user read this
 * hits the non-user-scoped endpoint and resolves each author's email, so
 * Reports and the completeness table see every teammate.
 */
export async function fetchTeamMonthWorklogsTempo(
	config: TempoServiceConfig,
	year: number,
	month: number, // 0-indexed
	signal?: AbortSignal,
): Promise<EnrichedJiraWorklog[]> {
	if (!config.jiraHost || !config.apiToken || !config.tempoApiToken) return [];
	const daysInMonth = new Date(year, month + 1, 0).getDate();
	const from = `${year}-${pad(month + 1)}-01`;
	const to = `${year}-${pad(month + 1)}-${pad(daysInMonth)}`;
	const worklogs = await fetchAllTempoWorklogs(config, null, from, to, signal);
	const emails = await fetchEmailsByAccountId(
		config,
		worklogs.map((w) => w.author?.accountId ?? ''),
		signal,
	);
	return enrichAndMap(config, worklogs, signal, emails);
}

export async function fetchWeekWorklogsTempo(
	config: TempoServiceConfig,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<WorklogEntry[]> {
	if (!config.jiraHost || !config.apiToken || !config.tempoApiToken) return [];
	const accountId = await resolveAccountId(config, signal);
	const worklogs = await fetchAllTempoWorklogs(
		config,
		accountId,
		weekStart,
		weekEnd,
		signal,
	);
	const enriched = await enrichAndMap(config, worklogs, signal);
	return enriched
		.filter((wl) => {
			const day = (wl.started ?? '').slice(0, 10);
			return day >= weekStart && day <= weekEnd;
		})
		.map((wl) => ({
			date: (wl.started ?? '').slice(0, 10),
			issueKey: wl.issue.key,
			issueSummary: wl.issue.fields.summary,
			timeSpentSeconds: wl.timeSpentSeconds ?? 0,
		}));
}
