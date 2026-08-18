import type { JiraWorklog } from '../../../types/jira';
import { isWeekend, wallClockDay } from './date';
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
 * Detect worklog-level warning flags that should cause this entry to be
 * excluded from calculation totals.
 *
 * Currently detects:
 * - **weekend-work** — worklogs whose wall-clock date falls on a weekend day.
 *
 * Day-level flags (incomplete, missing, overtime, absence-gap) are assessed
 * at the day level by their respective hooks and are not checked here.
 */
export function hasWarningFlags(wl: JiraWorklog): boolean {
	if (!wl.started) return false;
	const day = wallClockDay(wl.started);
	return day ? isWeekend(day) : false;
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
 * - **Flagged** entries — worklogs with worklog-level warning flags
 *   (e.g. weekend-work) are excluded from summation totals.
 */
export function shouldSkipWorklog(wl: JiraWorklog): WorklogSkipResult {
	const c = classifyWorklog(wl);
	if (c.isBackdated) {
		return { skip: true, reason: 'backdated' };
	}
	if (hasWarningFlags(wl)) {
		return { skip: true, reason: 'flagged' };
	}
	return { skip: false };
}
