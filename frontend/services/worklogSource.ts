/**
 * Decides whether worklog reads/writes use native Jira or Tempo, and a passive
 * predicate that detects Tempo-managed instances from worklog authors.
 */

/** True if any author looks like the Tempo app account (no human email). */
export function looksLikeTempoManaged(
	authors: Array<{ accountType?: string; displayName?: string } | undefined>,
): boolean {
	return authors.some(
		(a) => a?.accountType === 'app' || /tempo/i.test(a?.displayName ?? ''),
	);
}

/**
 * Whether a read needs worklogs for people other than the signed-in user.
 * `'team'` covers Reports, the team completeness table and the trend chart;
 * `'personal'` covers My Week, the heatmap and copy-previous-week.
 */
export type WorklogReadScope = 'personal' | 'team';

export interface WorklogSourceInput {
	tempoMode: 'auto' | 'jira' | 'tempo';
	tempoApiToken: string;
	tempoSuspected: boolean;
	/**
	 * Required on purpose: making this explicit forces the compiler to list
	 * every call site, so a new surface can't silently inherit the wrong scope.
	 */
	scope: WorklogReadScope;
}

export function getWorklogSource(input: WorklogSourceInput): 'jira' | 'tempo' {
	const hasToken = input.tempoApiToken.trim().length > 0;
	// ADA-545: every Tempo fetcher is hard-wired to the per-user endpoint
	// `GET /4/worklogs/user/{accountId}` (tempoWorklogService), so a team-scoped
	// read through Tempo returns ONLY the signed-in user — teammates vanish with
	// no error and no empty state, which reads as "nobody logged time". Until the
	// non-user-scoped `GET /4/worklogs` lands, team reads stay on native Jira.
	// Resolving this here (rather than inside worklogReadRouter) keeps the value
	// consistent with `monthWorklogsQueryKey`, which also keys on the source.
	if (input.scope === 'team') return 'jira';
	if (input.tempoMode === 'jira') return 'jira';
	if (input.tempoMode === 'tempo') return hasToken ? 'tempo' : 'jira';
	// auto
	return hasToken && input.tempoSuspected ? 'tempo' : 'jira';
}
