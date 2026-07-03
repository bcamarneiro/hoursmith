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
 * Resolve the monthly timesheet deadline (ADA-549): the Nth *working day*
 * (Mon–Fri) of the month AFTER the reported month. Timesheets for month M are
 * due early in M+1 — e.g. the 3rd working day of the following month.
 *
 * Skips weekends only; public holidays aren't subtracted (they vary per person
 * and per region — the weekly RAG history is the finer-grained signal).
 *
 * @param year             calendar year of the reported month.
 * @param monthZeroIndexed 0=Jan … 11=Dec of the reported month.
 * @param nthWorkingDay    1-based working-day ordinal in the following month.
 * @param time             `HH:MM` (24h, local).
 * @returns a `Date` at the local deadline moment.
 */
export function computeMonthlyDeadline(
	year: number,
	monthZeroIndexed: number,
	nthWorkingDay: number,
	time: string,
): Date {
	// First day of the following month (the Date constructor rolls Dec→Jan over).
	const cursor = new Date(year, monthZeroIndexed + 1, 1, 0, 0, 0, 0);
	let remaining = Math.max(1, Math.trunc(nthWorkingDay));
	// Walk forward day by day, counting weekdays until we land on the Nth.
	while (true) {
		const dayOfWeek = cursor.getDay(); // 0=Sun … 6=Sat
		if (dayOfWeek !== 0 && dayOfWeek !== 6) {
			remaining -= 1;
			if (remaining === 0) break;
		}
		cursor.setDate(cursor.getDate() + 1);
	}
	const match = time.match(/^(\d{1,2}):(\d{2})$/);
	const hours = match ? Number(match[1]) : 18;
	const minutes = match ? Number(match[2]) : 0;
	cursor.setHours(hours, minutes, 0, 0);
	return cursor;
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
