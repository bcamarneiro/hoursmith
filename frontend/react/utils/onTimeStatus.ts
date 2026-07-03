import { parseIsoDateLocal } from './date';

/**
 * On-time classification for a member's weekly timesheet (ADA-387).
 *
 * - `on-time`   — reached the completeness target with work logged *by* the
 *                 deadline.
 * - `late`      — reached the target, but only after the deadline.
 * - `incomplete`— deadline has passed and the target still isn't met.
 * - `pending`   — target not yet met, but the deadline hasn't passed, so there's
 *                 still time (the honest mid-week state — not a failure).
 */
export type OnTimeStatus = 'on-time' | 'late' | 'incomplete' | 'pending';

/**
 * Resolve the weekly deadline instant for a week.
 *
 * @param weekStart Monday of the week, `YYYY-MM-DD` (local).
 * @param weekday   1=Mon … 7=Sun.
 * @param time      `HH:MM` (24h, local).
 * @returns a `Date` at the local deadline moment.
 */
export function computeWeeklyDeadline(
	weekStart: string,
	weekday: number,
	time: string,
): Date {
	const dayOffset = Math.min(Math.max(Math.trunc(weekday), 1), 7) - 1;
	const date = parseIsoDateLocal(weekStart);
	date.setDate(date.getDate() + dayOffset);
	const match = time.match(/^(\d{1,2}):(\d{2})$/);
	const hours = match ? Number(match[1]) : 18;
	const minutes = match ? Number(match[2]) : 0;
	date.setHours(hours, minutes, 0, 0);
	return date;
}

/**
 * Derive the on-time status from completeness figures. Pure — the caller
 * supplies whether the deadline has passed so this stays free of `Date.now()`.
 */
export function deriveOnTimeStatus(args: {
	targetSeconds: number;
	totalSeconds: number;
	onTimeSeconds: number;
	deadlinePassed: boolean;
}): OnTimeStatus {
	// A zero target (e.g. a full week of PTO) is trivially satisfied.
	if (args.targetSeconds <= 0) return 'on-time';
	if (args.onTimeSeconds >= args.targetSeconds) return 'on-time';
	if (args.totalSeconds >= args.targetSeconds) return 'late';
	return args.deadlinePassed ? 'incomplete' : 'pending';
}

/** Human-readable label + tone for an on-time status (drives the badge). */
export function describeOnTimeStatus(status: OnTimeStatus): {
	label: string;
	tone: 'success' | 'warning' | 'error' | 'neutral';
} {
	switch (status) {
		case 'on-time':
			return { label: 'On time', tone: 'success' };
		case 'late':
			return { label: 'Late', tone: 'warning' };
		case 'incomplete':
			return { label: 'Incomplete', tone: 'error' };
		default:
			return { label: 'In progress', tone: 'neutral' };
	}
}
