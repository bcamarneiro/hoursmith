import type { EnrichedJiraWorklog } from '../../types/jira';
import { resolveAccountId } from './jiraIdentity';
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

/** Fetch every Tempo worklog for the user + range, following `metadata.next`. */
async function fetchAllTempoWorklogs(
	config: TempoServiceConfig,
	accountId: string,
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
	let path = `worklogs/user/${accountId}`;

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
): Promise<EnrichedJiraWorklog[]> {
	const ids = worklogs.map((w) => String(w.issue.id));
	const issueMap = await fetchIssueMetadata(ids, config, signal);
	return worklogs.map((w) => mapTempoWorklog(w, issueMap, config.email));
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
