import type { EnrichedJiraWorklog, JiraUser } from '../../types/jira';
import { resolveAccountId } from './jiraIdentity';
import { fromHttpResponse, fromNetworkError } from './serviceErrors';
import { buildTempoRequest } from './tempoGateway';
import {
	type TempoWorklog,
	fetchIssueMetadata,
	mapTempoWorklog,
	resolveAuthorMap,
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

/** Fetch every Tempo worklog for the range, following `metadata.next`. */
async function fetchAllTempoWorklogs(
	config: TempoServiceConfig,
	accountId: string,
	from: string,
	to: string,
	options: { currentUserOnly?: boolean } = {},
	signal?: AbortSignal,
): Promise<TempoWorklog[]> {
	const all: TempoWorklog[] = [];
	let params: URLSearchParams | null = new URLSearchParams({
		from,
		to,
		limit: '1000',
	});
	// Team-wide reads use `worklogs` (no user scope); user-scoped reads use
	// `worklogs/user/{accountId}`. The design spec (2026-06-24) requires the
	// non-user-scoped endpoint for team aggregation.
	let path = options.currentUserOnly === false
		? 'worklogs'
		: `worklogs/user/${accountId}`;

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
	options: { currentUserOnly?: boolean } = {},
	signal?: AbortSignal,
): Promise<EnrichedJiraWorklog[]> {
	const ids = worklogs.map((w) => String(w.issue.id));
	const issueMap = await fetchIssueMetadata(ids, config, signal);

	if (options.currentUserOnly === false) {
		// Team reads: resolve each distinct author.accountId → Jira user so the
		// mapped worklog carries the real author's email/displayName.
		const accountIds = worklogs
			.map((w) => w.author?.accountId)
			.filter((id): id is string => !!id);
		const authorMap = await resolveAuthorMap(config, accountIds, signal);
		return worklogs.map((w) => mapTempoWorklog(w, issueMap, authorMap));
	}

	// Current-user reads: all worklogs belong to the configured user, so use
	// their email directly (backward-compatible path).
	return worklogs.map((w) => mapTempoWorklog(w, issueMap, config.email));
}

export async function fetchMonthWorklogsTempo(
	config: TempoServiceConfig,
	year: number,
	month: number, // 0-indexed
	optionsOrSignal?: AbortSignal | { currentUserOnly?: boolean },
	maybeSignal?: AbortSignal,
): Promise<EnrichedJiraWorklog[]> {
	if (!config.jiraHost || !config.apiToken || !config.tempoApiToken) return [];

	// Backward-compatible overload: old callers pass signal as 4th arg.
	let signal: AbortSignal | undefined;
	let opts: { currentUserOnly?: boolean } = {};
	if (optionsOrSignal instanceof AbortSignal) {
		signal = optionsOrSignal;
	} else if (optionsOrSignal) {
		opts = optionsOrSignal;
		signal = maybeSignal;
	}

	const accountId = await resolveAccountId(config, signal);
	const daysInMonth = new Date(year, month + 1, 0).getDate();
	const from = `${year}-${pad(month + 1)}-01`;
	const to = `${year}-${pad(month + 1)}-${pad(daysInMonth)}`;
	const worklogs = await fetchAllTempoWorklogs(
		config,
		accountId,
		from,
		to,
		opts,
		signal,
	);
	return enrichAndMap(config, worklogs, opts, signal);
}

export async function fetchWeekWorklogsTempo(
	config: TempoServiceConfig,
	weekStart: string,
	weekEnd: string,
	optionsOrSignal?: AbortSignal | { currentUserOnly?: boolean },
	maybeSignal?: AbortSignal,
): Promise<WorklogEntry[]> {
	if (!config.jiraHost || !config.apiToken || !config.tempoApiToken) return [];

	// Backward-compatible overload: old callers pass signal as 4th arg.
	let signal: AbortSignal | undefined;
	let opts: { currentUserOnly?: boolean } = {};
	if (optionsOrSignal instanceof AbortSignal) {
		signal = optionsOrSignal;
	} else if (optionsOrSignal) {
		opts = optionsOrSignal;
		signal = maybeSignal;
	}

	const accountId = await resolveAccountId(config, signal);
	const worklogs = await fetchAllTempoWorklogs(
		config,
		accountId,
		weekStart,
		weekEnd,
		opts,
		signal,
	);
	const enriched = await enrichAndMap(config, worklogs, opts, signal);
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
