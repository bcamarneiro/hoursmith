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
	// `scope` no longer changes the answer — team reads gained their own
	// non-user-scoped fetcher in ADA-545, so both scopes may use Tempo. It is
	// still required on the input because `worklogReadRouter` needs it to pick
	// between the per-user and team endpoints: routing a team read at the
	// per-user endpoint silently returns only the signed-in user.
	if (input.tempoMode === 'jira') return 'jira';
	if (input.tempoMode === 'tempo') return hasToken ? 'tempo' : 'jira';
	// auto
	return hasToken && input.tempoSuspected ? 'tempo' : 'jira';
}
