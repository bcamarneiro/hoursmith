import type {
	RescueTimeActivity,
	RescueTimeDaySummary,
} from '../../types/Suggestion';
import { logger } from '../react/utils/logger';
import { buildRescueTimeRequest } from './rescueTimeGateway';
import { fromHttpResponse, ServiceError } from './serviceErrors';

/**
 * Fetch daily activity breakdown from RescueTime for the given week.
 * Returns a map of date -> RescueTimeDaySummary with productive hours
 * and top activities per day.
 *
 * Uses restrict_kind=activity to get per-app/site data grouped by day.
 * Requires the CORS proxy since RescueTime doesn't send CORS headers.
 *
 * SECURITY — API KEY EXPOSURE (ADA-466):
 * The RescueTime Analytic Data API only accepts the API key as the `key`
 * query-string parameter; it cannot be sent as an Authorization header upstream.
 * Routing is delegated to {@link buildRescueTimeRequest}:
 *   - hosted (Premium): the key travels in the `X-RescueTime-Key` header to our
 *     own relay, which appends it server-side — so it never appears in a URL the
 *     browser builds, and our endpoint never logs it.
 *   - self-hosted proxy: the key is embedded in the request URL sent to the
 *     user-configured CORS proxy, so that operator can read it (inherent to the
 *     user-supplied-proxy model — use a trusted proxy).
 * To avoid widening exposure, never log the URL, params, or apiKey here.
 */
export async function fetchRescueTimeData(
	apiKey: string,
	corsProxy: string,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<Map<string, RescueTimeDaySummary>> {
	if (!apiKey) return new Map();

	// Key is added by the gateway (header in hosted mode, query param otherwise).
	const params = new URLSearchParams({
		perspective: 'interval',
		restrict_kind: 'activity',
		// Hourly, not daily: the per-hour profile is what tells us when the day
		// actually started and where the breaks were, and a fixed 09:00 was
		// simply wrong for users who start earlier. The daily figures below are
		// summed from these rows, so nothing is lost. Measured cost for a week:
		// 656 rows / 43 KB against 231 rows / 16 KB — one call either way.
		resolution_time: 'hour',
		restrict_begin: weekStart,
		restrict_end: weekEnd,
		format: 'json',
	});

	// NOTE: `url`/`requestHeaders` may carry the API key (SECURITY note). No logs.
	const { url, headers: requestHeaders } = buildRescueTimeRequest(
		apiKey,
		corsProxy,
		params,
	);

	const res = await fetch(url, { headers: requestHeaders, signal });
	if (!res.ok) {
		if (res.status === 403) {
			throw new ServiceError({
				kind: 'invalid-token',
				status: 403,
				source: 'RescueTime',
				message: 'Invalid RescueTime API key',
			});
		}
		throw fromHttpResponse('RescueTime', res.status);
	}

	const data = (await res.json()) as {
		row_headers?: unknown;
		rows?: unknown;
	};

	// Validate the response shape before dereferencing. Without this, a missing
	// or malformed `row_headers` array threw on `.indexOf`, and a missing column
	// produced an index of -1 — `row[-1]` is `undefined`, silently corrupting
	// every row into a 0-seconds / empty-name activity. Fail loudly instead.
	if (!Array.isArray(data.row_headers)) {
		throw new ServiceError({
			kind: 'unknown',
			source: 'RescueTime',
			message:
				'RescueTime response malformed: missing or invalid "row_headers" array',
		});
	}
	if (!Array.isArray(data.rows)) {
		throw new ServiceError({
			kind: 'unknown',
			source: 'RescueTime',
			message: 'RescueTime response malformed: missing or invalid "rows" array',
		});
	}

	const headers = data.row_headers as string[];
	const rows = data.rows as (string | number)[][];

	// Row format with restrict_kind=activity, perspective=interval:
	// [Date, Time Spent (seconds), Number of People, Activity, Category, Productivity]
	const dateIdx = headers.indexOf('Date');
	const secondsIdx = headers.indexOf('Time Spent (seconds)');
	const activityIdx = headers.indexOf('Activity');
	const categoryIdx = headers.indexOf('Category');
	const productivityIdx = headers.indexOf('Productivity');

	// A -1 index means an expected column is absent. Continuing would map that
	// field to row[-1] (undefined) for every row, so reject the response.
	const requiredColumns: [string, number][] = [
		['Date', dateIdx],
		['Time Spent (seconds)', secondsIdx],
		['Activity', activityIdx],
		['Category', categoryIdx],
		['Productivity', productivityIdx],
	];
	const missing = requiredColumns
		.filter(([, idx]) => idx === -1)
		.map(([name]) => name);
	if (missing.length > 0) {
		throw new ServiceError({
			kind: 'unknown',
			source: 'RescueTime',
			message: `RescueTime response malformed: missing column(s): ${missing.join(', ')}`,
		});
	}

	// Group activities by date
	const byDay = new Map<string, RescueTimeActivity[]>();
	// Seconds per (day, hour), summed across every activity row in that hour.
	// Thresholded after accumulation; see the comment at the call site.
	const secondsByDayHour = new Map<string, Map<number, number>>();
	// First row whose Date column had no usable hour; reported once at the end.
	let unparsedHourExample: string | undefined;

	for (const row of rows) {
		const rawDate = String(row[dateIdx] ?? '');
		const dateStr = rawDate.slice(0, 10);
		if (!dateStr) continue;

		// RescueTime reports in the account's local timezone — verified against
		// a live account, whose latest reported hour matched the browser's local
		// hour exactly. So no conversion belongs here.
		// A date-only stamp would slice to '' and Number('') is 0, which passes
		// isFinite — crediting the whole day to hour 0 and laying every
		// suggestion out from midnight. Require the characters to be there.
		// Both failure shapes matter and neither should be silent: a
		// day-resolution row has no hour at all, and a space-separated stamp
		// slices to "9:" which is NaN. Either way `activeHours` empties and the
		// layout quietly reverts to its 09:00 fallback, indistinguishable from
		// having no RescueTime data. Warned once per fetch, not once per row —
		// a week is ~650 rows.
		const hour =
			rawDate.length >= 13 ? Number(rawDate.slice(11, 13)) : Number.NaN;
		if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
			unparsedHourExample ??= rawDate;
		} else if (Number(row[productivityIdx] ?? 0) >= 0) {
			// Same neutral-and-above bar as `productiveSeconds` below: an hour
			// spent entirely on distracting activity should not receive logged
			// time while contributing nothing to the productive total the
			// suggestions are scaled against.
			//
			// Accumulated per hour and thresholded later: with
			// restrict_kind=activity a busy hour is split across many
			// short-lived apps, so a per-row threshold would drop an hour of
			// twelve four-minute switches — losing the real start of the day.
			const perHour =
				secondsByDayHour.get(dateStr) ?? new Map<number, number>();
			perHour.set(
				hour,
				(perHour.get(hour) ?? 0) + Number(row[secondsIdx] ?? 0),
			);
			secondsByDayHour.set(dateStr, perHour);
		}

		const seconds = Number(row[secondsIdx] ?? 0);
		const productivity = Number(row[productivityIdx] ?? 0);

		const activity: RescueTimeActivity = {
			name: String(row[activityIdx] ?? ''),
			category: String(row[categoryIdx] ?? ''),
			seconds,
			productivity,
		};

		const existing = byDay.get(dateStr) || [];
		existing.push(activity);
		byDay.set(dateStr, existing);
	}

	// Build summaries: aggregate productive time, keep top activities
	const result = new Map<string, RescueTimeDaySummary>();

	for (const [date, activities] of byDay) {
		// Include neutral-and-above activity (productivity >= 0). RescueTime
		// scores activities from -2 (very distracting) to +2 (very productive),
		// with 0 = neutral. A lot of real dev work (terminals, generic browsing,
		// uncategorized tools) lands at neutral; the previous `>= 1` threshold
		// dropped it, systematically under-scaling "actual productive time" that
		// downstream scaling relies on. Only distracting time (negative) is
		// excluded.
		const isProductive = (a: RescueTimeActivity) => a.productivity >= 0;

		const productiveSeconds = activities
			.filter(isProductive)
			.reduce((sum, a) => sum + a.seconds, 0);

		// Merge activities with the same name (can appear under multiple categories)
		const mergedMap = new Map<string, RescueTimeActivity>();
		for (const a of activities.filter(isProductive)) {
			const existing = mergedMap.get(a.name);
			if (existing) {
				existing.seconds += a.seconds;
			} else {
				mergedMap.set(a.name, { ...a });
			}
		}

		// Top 5 productive activities by time spent
		const topActivities = [...mergedMap.values()]
			.sort((a, b) => b.seconds - a.seconds)
			.slice(0, 5);

		result.set(date, {
			productiveSeconds,
			topActivities,
			activeHours: [...(secondsByDayHour.get(date) ?? new Map())]
				// Five minutes in a whole hour is a stray notification, not work.
				.filter(([, seconds]) => seconds >= 300)
				.map(([hour]) => hour)
				.sort((a, b) => a - b),
		});
	}

	if (unparsedHourExample) {
		logger.warn(
			`[RescueTime] Date column carried no usable hour (e.g. "${unparsedHourExample}"). ` +
				'Day-shape detection is off; suggestions fall back to a 09:00 start.',
		);
	}

	return result;
}
