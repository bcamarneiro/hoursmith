/**
 * Worklog writes against the Tempo Cloud v4 API (ADA-544).
 *
 * Writes MUST follow reads. On a Tempo-managed instance a worklog POSTed to
 * Jira's native API is authored by the human rather than the Tempo app account,
 * so it either becomes invisible to the app-account filter the reads rely on, or
 * gets double-counted once Tempo imports it. `useWorklogOperations` therefore
 * branches on the same resolver the read router uses.
 *
 * Tempo identifies issues by numeric id, but every UI surface in this app speaks
 * issue keys, so each write resolves the key to an id via Jira first.
 */

import type { EnrichedJiraWorklog, JiraIssue } from '../../types/jira';
import { parseTimeSpentToSeconds } from '../react/utils/timeSpent';
import { resolveAccountId } from './jiraIdentity';
import { searchAllIssues } from './jiraSearch';
import { fromHttpResponse, fromNetworkError } from './serviceErrors';
import { buildTempoRequest, describeTempoNetworkError } from './tempoGateway';
import { mapTempoWorklog, type TempoWorklog } from './tempoMapper';
import type { TempoServiceConfig } from './tempoWorklogService';

export interface TempoWriteInput {
	issueKey: string;
	timeSpentSeconds: number;
	/** `YYYY-MM-DD` in the author's wall clock, matching Tempo's `startDate`. */
	startDate: string;
	/** `HH:MM:SS` in the author's wall clock, matching Tempo's `startTime`. */
	startTime: string;
	description: string;
	remainingEstimateSeconds?: number;
}

/**
 * Translate the Jira-shaped params the UI produces into Tempo's write shape.
 *
 * `started` is split on its own text rather than through `Date`: Tempo's
 * `startDate`/`startTime` are the worker's wall clock, so parsing to an instant
 * and re-reading it would shift a 00:30+02:00 worklog to the previous day.
 */
export function toTempoWriteInput(params: {
	issueKey: string;
	timeSpent: string;
	comment: string;
	started: string;
}): TempoWriteInput {
	const [datePart, timePart = ''] = params.started.split('T');
	const time = timePart.slice(0, 8);
	return {
		issueKey: params.issueKey,
		timeSpentSeconds: parseTimeSpentToSeconds(params.timeSpent),
		startDate: datePart,
		startTime: /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : '00:00:00',
		description: params.comment,
	};
}

/**
 * Resolve an issue key to the numeric id Tempo requires.
 *
 * Throws rather than defaulting: a wrong id would silently log time against
 * someone else's issue, which is worse than a failed save the user can retry.
 */
async function resolveIssueId(
	config: TempoServiceConfig,
	issueKey: string,
	signal?: AbortSignal,
): Promise<number> {
	const issues = await searchAllIssues<{ id?: string }>(
		config as unknown as Parameters<typeof searchAllIssues>[0],
		{ jql: `key = "${issueKey}"`, fields: 'summary', maxResults: 1 },
		{ signal },
	);
	const id = issues[0]?.id;
	if (!id) {
		throw new Error(
			`Could not resolve issue ${issueKey} to a Tempo issue id — the worklog was not saved.`,
		);
	}
	return Number(id);
}

async function tempoWrite(
	config: TempoServiceConfig,
	path: string,
	method: 'POST' | 'PUT' | 'DELETE',
	body?: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const { url, headers } = buildTempoRequest(
		config.tempoApiToken,
		config.corsProxy,
		path,
	);
	let res: Response;
	try {
		res = await fetch(url, {
			method,
			headers: { ...headers, 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		});
	} catch (err) {
		const generic = fromNetworkError('Tempo worklog write', err);
		throw new Error(
			describeTempoNetworkError(config.corsProxy, generic.message),
			{ cause: generic },
		);
	}
	if (!res.ok) throw fromHttpResponse('Tempo worklog write', res.status);
	if (res.status === 204) return null;
	return res.json().catch(() => null);
}

export async function createWorklogTempo(
	config: TempoServiceConfig,
	input: TempoWriteInput,
	signal?: AbortSignal,
): Promise<unknown> {
	const [issueId, authorAccountId] = await Promise.all([
		resolveIssueId(config, input.issueKey, signal),
		resolveAccountId(config, signal),
	]);
	return tempoWrite(
		config,
		'worklogs',
		'POST',
		{
			issueId,
			authorAccountId,
			timeSpentSeconds: input.timeSpentSeconds,
			startDate: input.startDate,
			startTime: input.startTime,
			description: input.description,
			...(input.remainingEstimateSeconds !== undefined
				? { remainingEstimateSeconds: input.remainingEstimateSeconds }
				: {}),
		},
		signal,
	);
}

export async function updateWorklogTempo(
	config: TempoServiceConfig,
	tempoWorklogId: string,
	input: TempoWriteInput,
	signal?: AbortSignal,
): Promise<unknown> {
	const [issueId, authorAccountId] = await Promise.all([
		resolveIssueId(config, input.issueKey, signal),
		resolveAccountId(config, signal),
	]);
	return tempoWrite(
		config,
		`worklogs/${tempoWorklogId}`,
		'PUT',
		{
			issueId,
			authorAccountId,
			timeSpentSeconds: input.timeSpentSeconds,
			startDate: input.startDate,
			startTime: input.startTime,
			description: input.description,
		},
		signal,
	);
}

export async function deleteWorklogTempo(
	config: TempoServiceConfig,
	tempoWorklogId: string,
	signal?: AbortSignal,
): Promise<void> {
	await tempoWrite(
		config,
		`worklogs/${tempoWorklogId}`,
		'DELETE',
		undefined,
		signal,
	);
}

/**
 * Map a Tempo write response onto the shape the timesheet store and month
 * caches expect.
 *
 * Tempo echoes a *Tempo* worklog: `tempoWorklogId`, `startDate`/`startTime`,
 * `description` — none of `id`, `started` or `comment`. Storing that raw leaves
 * a row that renders without a date, never patches into the month cache
 * (`worklogMonth()` returns null), and can never be matched again for edit or
 * delete because `wl.id` is undefined. Reuses `mapTempoWorklog` so writes and
 * reads produce identical rows.
 *
 * The issue is passed in because the caller has already resolved it — Tempo's
 * response carries only a numeric issue id.
 */
export function mapTempoWriteResponse(
	response: unknown,
	issue: JiraIssue,
	email: string,
	displayName?: string,
): EnrichedJiraWorklog {
	const wl = response as TempoWorklog;
	return mapTempoWorklog(
		wl,
		new Map([[String(wl.issue?.id ?? issue.id), issue]]),
		email,
		displayName,
	);
}
