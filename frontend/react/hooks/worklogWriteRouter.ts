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

/**
 * Refuse a write whose target row came from the other backend.
 *
 * Jira and Tempo worklog ids are separate id spaces, and in `auto` mode the
 * active source can flip mid-session: the first read is Jira (detection has not
 * run yet) and fills the store with Jira ids, then detection switches the
 * source to Tempo. An edit or delete in that window would send a Jira id to
 * `PUT`/`DELETE /4/worklogs/{id}`, which 404s at best and mutates an unrelated
 * worklog at worst.
 *
 * A row that is absent entirely (not in the store) is allowed through — the
 * guard cannot judge what it cannot see, and blocking there would gate every
 * write on cache completeness.
 *
 * A row that IS present but carries no `worklogSource` is treated as Jira,
 * because that is what such rows were before the field existed. That means a
 * pre-field cached row is refused while Tempo is active, which is deliberate:
 * a stale row is exactly the case where the id may belong to the other
 * backend, and a refresh is cheap next to deleting the wrong worklog.
 */
export function assertWritableRow(
	row: { worklogSource?: unknown; [key: string]: unknown } | undefined,
	writeSource: WorklogWriteSource,
): void {
	if (!row) return;
	const rowSource = row.worklogSource === 'tempo' ? 'tempo' : 'jira';
	if (rowSource === writeSource) return;
	throw new Error(
		`This worklog was loaded from ${rowSource} but ${writeSource} is now the active source. ` +
			'Refresh before editing it, so the change lands on the right worklog.',
	);
}

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
