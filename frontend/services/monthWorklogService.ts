import type { EnrichedJiraWorklog, JiraUser } from '../../types/jira';
import type { WorklogFetchProgress } from '../../types/worklogLoading';
import { logger } from '../react/utils/logger';
import { classifyWorklog } from '../react/utils/worklogClassifier';
import type { Config } from '../stores/useConfigStore';
import { rewriteForHostedProxy } from './jiraGateway';
import { searchAllIssues } from './jiraSearch';
import { fromHttpResponse } from './serviceErrors';

export type WorklogAuthor = JiraUser;
export type WorklogItem = EnrichedJiraWorklog;

export interface FetchMonthOptions {
	currentUserOnly?: boolean;
	jqlFilter?: string;
	onProgress?: (progress: WorklogFetchProgress) => void;
}

interface EmbeddedWorklog {
	self?: string;
	id?: string;
	author?: JiraUser;
	updateAuthor?: JiraUser;
	comment?: string | Record<string, unknown>;
	created?: string;
	updated?: string;
	started?: string;
	timeSpent?: string;
	timeSpentSeconds?: number;
	issueId?: string;
}

interface SearchIssue {
	id: string;
	key: string;
	self?: string;
	fields: {
		summary?: string;
		[key: string]: unknown;
		worklog?: {
			startAt: number;
			maxResults: number;
			total: number;
			worklogs: EmbeddedWorklog[];
		};
	};
}

function buildBaseUrl(config: Config): string {
	return config.corsProxy
		? `${config.corsProxy.replace(/\/$/, '')}/https://${config.jiraHost}`
		: `https://${config.jiraHost}`;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, Math.round(value)));
}

function emitProgress(
	onProgress: FetchMonthOptions['onProgress'],
	progress: WorklogFetchProgress,
) {
	onProgress?.({
		...progress,
		percent: clampPercent(progress.percent),
	});
}

export async function fetchMonthWorklogs(
	config: Config,
	year: number,
	month: number,
	options?: FetchMonthOptions,
	signal?: AbortSignal,
): Promise<WorklogItem[]> {
	if (!config.jiraHost || !config.apiToken) return [];

	const base = buildBaseUrl(config);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${config.apiToken}`,
		Accept: 'application/json',
		'X-Atlassian-Token': 'no-check',
	};

	const daysInMonth = new Date(year, month + 1, 0).getDate();
	const startStr = `${year}-${pad(month + 1)}-01`;
	const endStr = `${year}-${pad(month + 1)}-${pad(daysInMonth)}`;

	// Build JQL. App-generated clauses are wrapped in `(...)` and the optional
	// user filter is appended parenthesized so a filter ending in a trailing
	// `OR` (or any lower-precedence operator) can't widen the date/author scope
	// of the query. (ADA-467b)
	const appClauses = [
		`worklogDate >= "${startStr}" AND worklogDate <= "${endStr}"`,
	];
	if (options?.currentUserOnly) {
		appClauses.push('worklogAuthor = currentUser()');
	}
	let jql = `(${appClauses.join(') AND (')})`;
	if (options?.jqlFilter?.trim()) {
		jql += ` AND (${options.jqlFilter.trim()})`;
	}

	emitProgress(options?.onProgress, {
		phase: 'searching',
		percent: 8,
		message: 'Searching Jira issues with worklogs',
		detail: `${startStr} to ${endStr}`,
	});

	// Step 1: Search with embedded worklogs included
	// Jira embeds up to 20 worklogs per issue. For issues with ≤20 total
	// worklogs, we get everything from the search — no extra API call needed.
	const maxResults = 100;
	const fields = 'key,summary,issuetype,parent,project,status,worklog';

	const issues = await searchAllIssues<SearchIssue>(
		config,
		{ jql, fields, maxResults },
		{
			signal,
			onPage: (_pageIssues, { fetched, total }) => {
				if (typeof total === 'number') {
					// Server/DC: total known → render "page X of Y".
					const totalPages = Math.max(1, Math.ceil(total / maxResults));
					const currentPage = Math.min(
						totalPages,
						Math.max(1, Math.ceil(fetched / maxResults)),
					);
					const searchPercent = 10 + (currentPage / totalPages) * 35;
					emitProgress(options?.onProgress, {
						phase: 'searching',
						percent: searchPercent,
						message: 'Searching Jira issues with worklogs',
						detail: `Loaded search page ${currentPage} of ${totalPages}`,
					});
				} else {
					// Cloud: cursor pagination, no total → report the running count.
					emitProgress(options?.onProgress, {
						phase: 'searching',
						percent: 45,
						message: 'Searching Jira issues with worklogs',
						detail: `Loaded ${fetched} issue${fetched === 1 ? '' : 's'}`,
					});
				}
			},
		},
	);

	throwIfAborted(signal);

	emitProgress(options?.onProgress, {
		phase: 'inspecting',
		percent: 55,
		message: 'Reviewing embedded worklogs from search results',
		detail: `${issues.length} issue${issues.length === 1 ? '' : 's'} returned from Jira`,
	});

	// When scoping to the current user, the JQL `worklogAuthor = currentUser()`
	// only restricts which ISSUES match — a shared issue still returns every
	// author's worklogs. Filter per-worklog by email so other authors' entries
	// on shared issues are dropped, matching the week path in worklogService.
	// (ADA-467a)
	const userEmail = options?.currentUserOnly
		? config.email.toLowerCase()
		: null;
	const matchesAuthor = (wl: EmbeddedWorklog): boolean =>
		!userEmail || wl.author?.emailAddress?.toLowerCase() === userEmail;

	// Step 2: Split issues into complete (embedded has all worklogs) vs truncated
	const allWorklogs: WorklogItem[] = [];
	const truncatedIssues: SearchIssue[] = [];

	for (const issue of issues) {
		const embedded = issue.fields.worklog;
		if (!embedded) {
			truncatedIssues.push(issue);
			continue;
		}

		if (embedded.total <= embedded.maxResults) {
			// Embedded worklogs are COMPLETE — use them directly, filter by date in JS
			for (const wl of embedded.worklogs) {
				if (!matchesAuthor(wl)) continue;
				const day = classifyWorklog(wl).loggedOn;
				if (day && day >= startStr && day <= endStr) {
					allWorklogs.push({ ...wl, issue });
				}
			}
		} else {
			// Embedded worklogs are TRUNCATED — need separate fetch
			truncatedIssues.push(issue);
		}
	}

	// Step 3: Fetch full worklogs only for truncated issues (typically very few)
	if (truncatedIssues.length > 0) {
		logger.debug(
			`[MonthWorklogs] ${issues.length} issues: ${issues.length - truncatedIssues.length} complete from search, ${truncatedIssues.length} need separate fetch`,
		);

		const startMillis = new Date(year, month, 1).getTime();
		const endMillis = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
		const batchSize = 20;
		const totalBatches = Math.max(
			1,
			Math.ceil(truncatedIssues.length / batchSize),
		);

		for (let i = 0; i < truncatedIssues.length; i += batchSize) {
			throwIfAborted(signal);
			const batch = truncatedIssues.slice(i, i + batchSize);
			const batchIndex = Math.floor(i / batchSize) + 1;
			const processedIssues = Math.min(
				i + batch.length,
				truncatedIssues.length,
			);
			const truncatedPercent = 60 + (batchIndex / totalBatches) * 35;
			emitProgress(options?.onProgress, {
				phase: 'fetching-truncated',
				percent: truncatedPercent,
				message: 'Fetching full worklogs for truncated issues',
				detail: `Batch ${batchIndex} of ${totalBatches} · ${processedIssues} of ${truncatedIssues.length} issue${truncatedIssues.length === 1 ? '' : 's'}`,
			});
			// A real failure on these supplementary per-issue fetches must NOT be
			// swallowed: silently returning [] for a truncated issue undercounts
			// the month and presents partial data as complete. Let the error
			// propagate so the whole month is marked failed. An aborted signal is
			// a clean cancel (AbortError), not a failure. (ADA-456a)
			const results = await Promise.all(
				batch.map(async (issue) => {
					const url = `${base}/rest/api/2/issue/${issue.key}/worklog?startedAfter=${startMillis}&startedBefore=${endMillis}`;
					const rewritten = rewriteForHostedProxy(url, headers, {
						jiraHost: config.jiraHost,
						email: config.email,
						apiToken: config.apiToken,
					});
					const res = await fetch(rewritten.url, {
						headers: rewritten.headers,
						signal,
					});
					if (!res.ok) {
						throw fromHttpResponse('Jira issue worklog', res.status, issue.key);
					}
					const data = (await res.json()) as {
						worklogs: EmbeddedWorklog[];
					};
					return (data.worklogs || [])
						.filter(matchesAuthor)
						.map((wl) => ({ ...wl, issue }));
				}),
			);
			for (const worklogs of results) {
				allWorklogs.push(...worklogs);
			}
		}
	} else {
		logger.debug(
			`[MonthWorklogs] ${issues.length} issues — all worklogs from search response (0 extra requests)`,
		);
		emitProgress(options?.onProgress, {
			phase: 'fetching-truncated',
			percent: 90,
			message: 'Using embedded worklogs from the search response',
			detail: `No extra issue worklog requests were needed for ${issues.length} issue${issues.length === 1 ? '' : 's'}`,
		});
	}

	logger.debug(`[MonthWorklogs] Total: ${allWorklogs.length} worklogs`);
	emitProgress(options?.onProgress, {
		phase: 'complete',
		percent: 100,
		message: 'Worklogs loaded',
		detail: `${allWorklogs.length} worklog${allWorklogs.length === 1 ? '' : 's'} ready`,
	});
	return allWorklogs;
}
