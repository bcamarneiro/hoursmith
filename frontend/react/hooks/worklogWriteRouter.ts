/**
 * Write counterpart to `worklogReadRouter` (ADA-544).
 *
 * Reads and writes must swap together. On a Tempo-managed instance a worklog
 * POSTed to Jira's native API is authored by the human rather than the Tempo
 * app account, so it either never shows up in the reads (which filter on that
 * app account) or gets double-counted once Tempo imports it. Splitting the two
 * would be worse than having no Tempo support at all — the user would see one
 * set of hours and silently create another.
 *
 * The Jira paths are injected as callbacks so `useWorklogOperations` keeps
 * owning its existing request construction, optimistic updates and error
 * handling; this module only decides which way a write goes.
 */

import type { TempoServiceConfig } from '../../services/tempoWorklogService';
import {
	createWorklogTempo,
	deleteWorklogTempo,
	type TempoWriteInput,
	updateWorklogTempo,
} from '../../services/tempoWriteService';

export type WorklogWriteSource = 'jira' | 'tempo';

export async function writeCreate<T>(
	source: WorklogWriteSource,
	config: TempoServiceConfig,
	jiraCreate: (input: TempoWriteInput) => Promise<T>,
	input: TempoWriteInput,
	signal?: AbortSignal,
): Promise<unknown> {
	return source === 'tempo'
		? createWorklogTempo(config, input, signal)
		: jiraCreate(input);
}

export async function writeUpdate<T>(
	source: WorklogWriteSource,
	config: TempoServiceConfig,
	jiraUpdate: (worklogId: string, input: TempoWriteInput) => Promise<T>,
	worklogId: string,
	input: TempoWriteInput,
	signal?: AbortSignal,
): Promise<unknown> {
	return source === 'tempo'
		? updateWorklogTempo(config, worklogId, input, signal)
		: jiraUpdate(worklogId, input);
}

export async function writeDelete<T>(
	source: WorklogWriteSource,
	config: TempoServiceConfig,
	jiraDelete: (issueKey: string, worklogId: string) => Promise<T>,
	issueKey: string,
	worklogId: string,
	signal?: AbortSignal,
): Promise<unknown> {
	return source === 'tempo'
		? deleteWorklogTempo(config, worklogId, signal)
		: jiraDelete(issueKey, worklogId);
}
