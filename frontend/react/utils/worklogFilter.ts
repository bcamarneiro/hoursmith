import type { JiraWorklog } from '../../../types/jira';
import { classifyWorklog } from './worklogClassifier';

/** Categories for why a worklog entry should be skipped during summation. */
export type SkipReason = 'backdated' | 'flagged';

export interface WorklogSkipResult {
	/**
	 * True when this entry should be excluded from hour totals in
	 * Dashboard, Reports, Team weekly, and similar calculation loops.
	 */
	skip: boolean;
	/** Categorisation so callers that track skipped entries separately (e.g.
	 *  `useDayCalculation` buckets backdated seconds) can branch on it. */
	reason?: SkipReason;
}

/**
 * Single source of truth for "should this worklog be excluded from
 * summation?".
 *
 * Every calculation loop (day, month, team, heatmap, dashboard) delegates
 * here so that new skip conditions — whether from WarningFlags, date-level
 * flags, or future mechanisms — can be added in one place without touching
 * each loop individually.
 *
 * Currently skips:
 * - **Backdated** entries — they appear as ghosts / side-notes only, never
 *   counted toward hour totals (AGENTS.md ghost-reconciliation invariant).
 */
export function shouldSkipWorklog(wl: JiraWorklog): WorklogSkipResult {
	const c = classifyWorklog(wl);
	if (c.isBackdated) {
		return { skip: true, reason: 'backdated' };
	}
	return { skip: false };
}
