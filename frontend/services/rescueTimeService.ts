import type {
	RescueTimeActivity,
	RescueTimeDaySummary,
} from '../../types/Suggestion';
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
 * query-string parameter; it cannot be sent as an Authorization header.
 * This means the key is embedded in the request URL. When `corsProxy` is set,
 * the *full URL — including the key —* is sent to the user-configured CORS
 * proxy, so that proxy operator can read the key. This is an inherent
 * limitation of the RescueTime API and the user-supplied-proxy model; the
 * mitigation is to only use a trusted proxy. To avoid widening the exposure,
 * never log this URL, the params, or the apiKey anywhere in this file.
 */
export async function fetchRescueTimeData(
	apiKey: string,
	corsProxy: string,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<Map<string, RescueTimeDaySummary>> {
	if (!apiKey) return new Map();

	const params = new URLSearchParams({
		key: apiKey,
		perspective: 'interval',
		restrict_kind: 'activity',
		resolution_time: 'day',
		restrict_begin: weekStart,
		restrict_end: weekEnd,
		format: 'json',
	});

	const baseUrl = 'https://www.rescuetime.com/anapi/data';
	// NOTE: `url` contains the API key (see SECURITY note above). Do not log it.
	const url = corsProxy
		? `${corsProxy.replace(/\/$/, '')}/${baseUrl}?${params}`
		: `${baseUrl}?${params}`;

	const res = await fetch(url, { signal });
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

	for (const row of rows) {
		const dateStr = String(row[dateIdx] ?? '').slice(0, 10);
		if (!dateStr) continue;

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

		result.set(date, { productiveSeconds, topActivities });
	}

	return result;
}
