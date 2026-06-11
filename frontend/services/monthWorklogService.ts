import type { EnrichedJiraWorklog, JiraUser } from '../../types/jira';
import type { WorklogFetchProgress } from '../../types/worklogLoading';
import { logger } from '../react/utils/logger';
import { classifyWorklog } from '../react/utils/worklogClassifier';
import type { Config } from '../stores/useConfigStore';
import { rewriteForHostedProxy } from './jiraGateway';
import { searchAllIssues } from './jiraSearch';

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

	// Build JQL
	let jql = `worklogDate >= "${startStr}" AND worklogDate <= "${endStr}"`;
	if (options?.currentUserOnly) {
		jql += ' AND worklogAuthor = currentUser()';
	}
	if (options?.jqlFilter?.trim()) {
		jql += ` AND ${options.jqlFilter.trim()}`;
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

	if (signal?.aborted) return [];

	emitProgress(options?.onProgress, {
		phase: 'inspecting',
		percent: 55,
		message: 'Reviewing embedded worklogs from search results',
		detail: `${issues.length} issue${issues.length === 1 ? '' : 's'} returned from Jira`,
	});

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
			if (signal?.aborted) return [];
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
			const results = await Promise.all(
				batch.map(async (issue) => {
					try {
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
						if (!res.ok) return [];
						const data = (await res.json()) as {
							worklogs: EmbeddedWorklog[];
						};
						return (data.worklogs || []).map((wl) => ({
							...wl,
							issue,
						}));
					} catch {
						return [];
					}
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
