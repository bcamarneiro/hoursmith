import type {
	WakaTimeDaySummary,
	WakaTimeProjectDuration,
} from '../../types/Suggestion';
import { fromHttpResponse, ServiceError } from './serviceErrors';

/**
 * Default WakaTime API base URL. Users running self-hosted Wakapi (API-compatible)
 * can override this via the `wakatimeBaseUrl` config field.
 */
const DEFAULT_BASE_URL = 'https://api.wakatime.com';

/**
 * Fetch daily coding duration per project from WakaTime (or Wakapi) for the
 * given week range. Returns a map of date → WakaTimeDaySummary.
 *
 * WakaTime gives real coding **duration** per project/day via the Summaries
 * endpoint — not spiky events — so it can pre-fill the worklog *quantity*,
 * not just a timestamp.
 *
 * Auth: Basic with base64-encoded API key (no OAuth). The API key is sent as
 * the username with an empty password.
 *
 * Self-hosted Wakapi is API-compatible — set `baseUrl` to the Wakapi instance
 * URL (e.g. `https://wakapi.example.com`).
 *
 * Requires a CORS proxy since WakaTime doesn't send CORS headers for
 * browser-based requests.
 */
export async function fetchWakaTimeData(
	apiKey: string,
	corsProxy: string,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
	baseUrl?: string,
): Promise<Map<string, WakaTimeDaySummary>> {
	if (!apiKey) return new Map();

	const host = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
	const params = new URLSearchParams({
		start: weekStart,
		end: weekEnd,
	});

	const apiPath = `${host}/api/v1/users/current/summaries?${params}`;

	// WakaTime uses Basic auth: base64(apiKey + ":")
	const encodedKey = btoa(`${apiKey}:`);

	const url = corsProxy
		? `${corsProxy.replace(/\/+$/, '')}/${apiPath}`
		: apiPath;

	const res = await fetch(url, {
		signal,
		headers: {
			Authorization: `Basic ${encodedKey}`,
		},
	});

	if (!res.ok) {
		if (res.status === 401) {
			throw new ServiceError({
				kind: 'invalid-token',
				status: 401,
				source: 'WakaTime',
				message: 'Invalid WakaTime API key',
			});
		}
		throw fromHttpResponse('WakaTime', res.status);
	}

	const json = (await res.json()) as {
		data?: unknown;
	};

	if (!Array.isArray(json.data)) {
		throw new ServiceError({
			kind: 'unknown',
			source: 'WakaTime',
			message:
				'WakaTime response malformed: missing or invalid "data" array',
		});
	}

	const result = new Map<string, WakaTimeDaySummary>();

	for (const day of json.data as Array<{
		date?: unknown;
		projects?: unknown;
	}>) {
		const dateStr =
			typeof day.date === 'string' ? day.date.slice(0, 10) : '';
		if (!dateStr) continue;

		if (!Array.isArray(day.projects)) continue;

		const projects: WakaTimeProjectDuration[] = [];
		let totalCodingSeconds = 0;

		for (const proj of day.projects as Array<{
			name?: unknown;
			total_seconds?: unknown;
		}>) {
			const name = typeof proj.name === 'string' ? proj.name : '';
			const totalSeconds = Number(proj.total_seconds ?? 0);
			if (!name || totalSeconds <= 0) continue;

			projects.push({ name, totalSeconds });
			totalCodingSeconds += totalSeconds;
		}

		// Sort projects by duration descending
		projects.sort((a, b) => b.totalSeconds - a.totalSeconds);

		if (projects.length > 0) {
			result.set(dateStr, { totalCodingSeconds, projects });
		}
	}

	return result;
}
