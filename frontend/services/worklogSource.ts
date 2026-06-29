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

export interface WorklogSourceInput {
	tempoMode: 'auto' | 'jira' | 'tempo';
	tempoApiToken: string;
	tempoSuspected: boolean;
}

export function getWorklogSource(input: WorklogSourceInput): 'jira' | 'tempo' {
	const hasToken = input.tempoApiToken.trim().length > 0;
	if (input.tempoMode === 'jira') return 'jira';
	if (input.tempoMode === 'tempo') return hasToken ? 'tempo' : 'jira';
	// auto
	return hasToken && input.tempoSuspected ? 'tempo' : 'jira';
}
