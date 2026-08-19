/**
 * Decides whether worklog reads/writes use native Jira or Tempo, and a passive
 * predicate that detects Tempo-managed instances from worklog authors.
 */

/**
 * True if any author looks like the **Tempo** app account.
 *
 * Both signals are required, not either: `accountType === 'app'` alone matches
 * any Jira app (Automation for Jira, a migration tool, a bot), and a name match
 * alone matches a human called Tempo. In `auto` mode with a token present,
 * either false positive silently re-routes every read *and write* to Tempo on
 * an instance that does not use it — so the conjunction is deliberate.
 *
 * The cost of a false negative is much lower: the user sets the mode manually.
 */
export function looksLikeTempoManaged(
	authors: Array<{ accountType?: string; displayName?: string } | undefined>,
): boolean {
	return authors.some(
		(a) => a?.accountType === 'app' && /tempo/i.test(a?.displayName ?? ''),
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
