import type { JiraWorklog } from '../../../types/jira';
import { BASELINE_DAY_SECONDS } from './dayTarget';

// ── Reason types ────────────────────────────────────────────────────────────

export type AnomalyKind = 'under-logged' | 'duplicate' | 'round-hours';

export interface UnderLoggedReason {
	kind: 'under-logged';
	/** ISO date (YYYY-MM-DD) the stats were computed for. */
	day: string;
	/** Total seconds logged on the day. */
	loggedSeconds: number;
	/** Target seconds for the day (usually 8 h on a weekday). */
	targetSeconds: number;
	/** Ratio of logged to target (0–1+). Below `threshold` triggers the flag. */
	ratio: number;
}

export interface DuplicateReason {
	kind: 'duplicate';
	/** Jira issue key shared by the duplicate entries. */
	issueKey: string;
	/** Seconds logged in each duplicate entry. */
	timeSpentSeconds: number;
	/** Worklog ids that form the duplicate cluster. */
	worklogIds: string[];
}

export interface RoundHoursReason {
	kind: 'round-hours';
	/** Jira issue key of the flagged worklog. */
	issueKey: string;
	/** The worklog id, if available. */
	worklogId?: string;
	/** Time spent in seconds — a whole-hour value. */
	timeSpentSeconds: number;
	/** Whole hours (timeSpentSeconds / 3600). */
	wholeHours: number;
}

export type AnomalyReason =
	| UnderLoggedReason
	| DuplicateReason
	| RoundHoursReason;

// ── Day stats ───────────────────────────────────────────────────────────────

export interface DayStats {
	/** ISO date (YYYY-MM-DD). */
	day: string;
	/** Sum of timeSpentSeconds across all worklogs. */
	totalSeconds: number;
	/** Number of worklog entries. */
	entryCount: number;
	/** Distinct issue keys logged on this day. */
	uniqueIssues: string[];
}

/**
 * Compute aggregate stats for a single day's worth of worklogs.
 *
 * Pure — no side effects. The `day` parameter is caller-supplied so this
 * helper stays agnostic of the bucketing strategy (wall-clock, intended-for,
 * etc.).
 */
export function computeDayStats(
	day: string,
	worklogs: ReadonlyArray<Pick<JiraWorklog, 'timeSpentSeconds' | 'issueKey'>>,
): DayStats {
	let totalSeconds = 0;
	const issueSet = new Set<string>();

	for (const wl of worklogs) {
		totalSeconds += wl.timeSpentSeconds ?? 0;
		if (wl.issueKey) issueSet.add(wl.issueKey);
	}

	return {
		day,
		totalSeconds,
		entryCount: worklogs.length,
		uniqueIssues: [...issueSet].sort(),
	};
}

// ── Under-logging detection ─────────────────────────────────────────────────

export interface UnderLoggedOptions {
	/**
	 * Ratio threshold below which a day is flagged. Defaults to 0.5 (50 % of
	 * target). A weekday with 8 h target and 3 h logged → ratio 0.375 → flagged.
	 */
	threshold?: number;
}

/**
 * Flag a day when the ratio of logged seconds to target seconds falls below
 * `threshold`. Weekends (target = 0) are never flagged.
 */
export function detectUnderLogged(
	stats: DayStats,
	targetSeconds: number,
	options: UnderLoggedOptions = {},
): UnderLoggedReason | null {
	const threshold = options.threshold ?? 0.5;

	// No target → nothing to be under on (weekends, full-absence days).
	if (targetSeconds <= 0) return null;

	// Zero entries on a day with a target is a valid anomaly.
	if (stats.entryCount === 0) {
		return {
			kind: 'under-logged',
			day: stats.day,
			loggedSeconds: 0,
			targetSeconds,
			ratio: 0,
		};
	}

	const ratio = stats.totalSeconds / targetSeconds;
	if (ratio < threshold) {
		return {
			kind: 'under-logged',
			day: stats.day,
			loggedSeconds: stats.totalSeconds,
			targetSeconds,
			ratio,
		};
	}

	return null;
}

// ── Duplicate detection ─────────────────────────────────────────────────────

/**
 * Detect clusters of worklogs on the same issue with identical time-spent
 * values — a strong signal of accidental double-logging.
 *
 * Only considers worklogs that have both an `issueKey` and a `timeSpentSeconds`
 * value. Returns one {@link DuplicateReason} per cluster of 2+ matches.
 */
export function detectDuplicates(
	worklogs: ReadonlyArray<
		Pick<JiraWorklog, 'issueKey' | 'timeSpentSeconds' | 'id'>
	>,
): DuplicateReason[] {
	// Bucket by `${issueKey}|${timeSpentSeconds}`.
	const buckets = new Map<string, string[]>();

	for (const wl of worklogs) {
		if (!wl.issueKey || wl.timeSpentSeconds == null) continue;
		const key = `${wl.issueKey}|${wl.timeSpentSeconds}`;
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = [];
			buckets.set(key, bucket);
		}
		bucket.push(wl.id ?? '');
	}

	const reasons: DuplicateReason[] = [];
	for (const [compositeKey, ids] of buckets) {
		if (ids.length < 2) continue;
		const [issueKey, secondsStr] = compositeKey.split('|');
		reasons.push({
			kind: 'duplicate',
			issueKey,
			timeSpentSeconds: Number(secondsStr),
			worklogIds: ids,
		});
	}

	return reasons;
}

// ── Round-hours detection ──────────────────────────────────────────────────

export interface RoundHoursOptions {
	/**
	 * Minimum whole hours to flag. Defaults to 1 — any worklog that is an
	 * exact multiple of 3600 s (1 h, 2 h, 4 h, 8 h …) is flagged.
	 */
	minHours?: number;
}

/**
 * Flag worklogs whose `timeSpentSeconds` is an exact whole-hour multiple.
 *
 * Whole-hour entries (1 h, 2 h, 4 h, 8 h) are a common signal of estimated
 * rather than actual time tracking. The function is deterministic and pure.
 */
export function detectRoundHours(
	worklogs: ReadonlyArray<
		Pick<JiraWorklog, 'issueKey' | 'timeSpentSeconds' | 'id'>
	>,
	options: RoundHoursOptions = {},
): RoundHoursReason[] {
	const minHours = options.minHours ?? 1;
	const reasons: RoundHoursReason[] = [];

	for (const wl of worklogs) {
		const seconds = wl.timeSpentSeconds;
		if (seconds == null || seconds <= 0) continue;
		if (seconds % 3600 !== 0) continue;

		const wholeHours = seconds / 3600;
		if (wholeHours < minHours) continue;

		reasons.push({
			kind: 'round-hours',
			issueKey: wl.issueKey ?? '',
			worklogId: wl.id,
			timeSpentSeconds: seconds,
			wholeHours,
		});
	}

	return reasons;
}

// ── Combined entry point ───────────────────────────────────────────────────

export interface AnomalyDetectionOptions
	extends UnderLoggedOptions,
		RoundHoursOptions {}

export interface DayAnomalies {
	day: string;
	stats: DayStats;
	reasons: AnomalyReason[];
}

/**
 * Run all anomaly detectors against a single day's worklogs and return the
 * aggregated reasons. Pure — safe to call from selectors and tests.
 */
export function detectDayAnomalies(
	day: string,
	worklogs: ReadonlyArray<JiraWorklog>,
	targetSeconds: number = BASELINE_DAY_SECONDS,
	options: AnomalyDetectionOptions = {},
): DayAnomalies {
	const stats = computeDayStats(day, worklogs);
	const reasons: AnomalyReason[] = [];

	const underLogged = detectUnderLogged(stats, targetSeconds, options);
	if (underLogged) reasons.push(underLogged);

	reasons.push(...detectDuplicates(worklogs));
	reasons.push(...detectRoundHours(worklogs, options));

	return { day, stats, reasons };
}
