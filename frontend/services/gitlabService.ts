import type { WorklogSuggestion } from '../../types/Suggestion';
import { fromRichMessage, ServiceError } from './serviceErrors';

// Match standard Jira issue keys (e.g. PROJ-12, A-1) while requiring a left
// boundary so we don't extract `PROJ-5` from a longer token like `XPROJ-5`.
// `[A-Z][A-Z0-9]*` allows single-letter project keys (`A-1`).
const JIRA_KEY_RE = /(?<![A-Z0-9])([A-Z][A-Z0-9]*-\d+)/g;

interface GitLabEvent {
	action_name: string;
	created_at: string;
	target_type?: string;
	target_title?: string;
	note?: {
		body?: string;
		noteable_type?: string;
	};
	push_data?: {
		commit_title?: string;
		ref?: string;
		commit_count?: number;
	};
}

type ActivityType = 'push' | 'mr-action' | 'review';

interface ActivityEntry {
	type: ActivityType;
	count: number;
	reasons: string[];
}

const PUSH_ACTIONS = new Set(['pushed to', 'pushed new']);
const MR_ACTIONS = new Set([
	'accepted',
	'merged',
	'opened',
	'closed',
	'approved',
]);
const REVIEW_ACTIONS = new Set(['commented on']);

export function normalizeGitlabHost(gitlabHost: string): string {
	return gitlabHost.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function buildGitlabBaseUrl(
	gitlabHost: string,
	corsProxy: string,
): string {
	const cleanHost = normalizeGitlabHost(gitlabHost);
	const gitlabOrigin = `https://${cleanHost}`;
	return corsProxy
		? `${corsProxy.replace(/\/$/, '')}/${gitlabOrigin}`
		: gitlabOrigin;
}

async function describeGitlabErrorResponse(
	res: Response,
	cleanHost: string,
): Promise<string> {
	let detail = '';

	try {
		const body = (await res.text()).trim();
		if (body) {
			detail = body.length > 160 ? `${body.slice(0, 157)}...` : body;
		}
	} catch {
		// ignore body parse failures
	}

	if (res.status === 401) {
		return `GitLab rejected the token for ${cleanHost} (401). Check that the token is still active and has read_user or api scope.`;
	}

	if (res.status === 403) {
		return `GitLab accepted the request but denied access on ${cleanHost} (403). Check account access and PAT scopes.`;
	}

	if (res.status === 404) {
		return `Could not find the GitLab API on ${cleanHost} (404). Confirm the hostname and whether this self-hosted instance uses a custom base path.`;
	}

	return detail
		? `GitLab API error on ${cleanHost}: ${res.status}. ${detail}`
		: `GitLab API error on ${cleanHost}: ${res.status}.`;
}

export function describeGitlabConnectionError(
	error: unknown,
	cleanHost: string,
): string {
	if (
		error instanceof TypeError ||
		(error instanceof Error && /fetch|network/i.test(error.message))
	) {
		return `Could not reach ${cleanHost}. Check the hostname, VPN/certificate trust, or route the request through the CORS proxy.`;
	}

	return error instanceof Error ? error.message : 'GitLab connection failed';
}

function extractJiraKeys(text: string): string[] {
	const matches = text.match(JIRA_KEY_RE);
	return matches ? [...new Set(matches)] : [];
}

function dateOnly(iso: string): string {
	return iso.slice(0, 10);
}

/**
 * Shift a `YYYY-MM-DD` date by a whole number of days (UTC).
 *
 * GitLab's Events API treats `after`/`before` as *exclusive* bounds, so to
 * include events that happened on `weekStart`/`weekEnd` we widen the query
 * window by one day on each side and rely on the inclusive client-side filter
 * to trim the extras.
 */
function shiftDay(date: string, deltaDays: number): string {
	const ts = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
	const shifted = new Date(ts + deltaDays * 24 * 60 * 60 * 1000);
	return shifted.toISOString().slice(0, 10);
}

function isPushEvent(action: string): boolean {
	return PUSH_ACTIONS.has(action);
}

function isMrActionEvent(event: GitLabEvent): boolean {
	return (
		MR_ACTIONS.has(event.action_name) && event.target_type === 'MergeRequest'
	);
}

function isReviewEvent(event: GitLabEvent): boolean {
	return (
		REVIEW_ACTIONS.has(event.action_name) &&
		(event.target_type === 'MergeRequest' ||
			event.note?.noteable_type === 'MergeRequest')
	);
}

function getEntry(
	map: Map<string, ActivityEntry>,
	mapKey: string,
	type: ActivityType,
): ActivityEntry {
	let entry = map.get(mapKey);
	if (!entry) {
		entry = { type, count: 0, reasons: [] };
		map.set(mapKey, entry);
	}
	return entry;
}

function formatReason(entry: ActivityEntry): string {
	const { type, count, reasons } = entry;
	const snippet =
		reasons.length > 0
			? `: ${reasons.slice(0, 2).join('; ')}${reasons.length > 2 ? '...' : ''}`
			: '';

	switch (type) {
		case 'push':
			return `${count} commit${count > 1 ? 's' : ''}${snippet}`;
		case 'mr-action':
			return `${count} MR action${count > 1 ? 's' : ''}${snippet}`;
		case 'review':
			return `${count} review comment${count > 1 ? 's' : ''}${snippet}`;
	}
}

const TIME_ESTIMATES: Record<ActivityType, { perUnit: number; max: number }> = {
	push: { perUnit: 3600, max: 4 * 3600 },
	'mr-action': { perUnit: 1800, max: 2 * 3600 },
	review: { perUnit: 900, max: 2 * 3600 },
};

function estimateSeconds(type: ActivityType, count: number): number {
	const { perUnit, max } = TIME_ESTIMATES[type];
	return Math.min(count * perUnit, max);
}

function estimateConfidence(
	type: ActivityType,
	count: number,
): 'high' | 'medium' | 'low' {
	if (type === 'push') return count >= 3 ? 'high' : 'medium';
	if (type === 'mr-action') return 'medium';
	return count >= 3 ? 'medium' : 'low';
}

/**
 * Fetch the user's recent GitLab events (pushes, MR actions, review comments)
 * and extract Jira issue keys to build worklog suggestions.
 */
export async function fetchGitlabSuggestions(
	gitlabToken: string,
	gitlabHost: string,
	corsProxy: string,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<WorklogSuggestion[]> {
	if (!gitlabToken || !gitlabHost) return [];

	const cleanHost = normalizeGitlabHost(gitlabHost);
	const baseUrl = buildGitlabBaseUrl(gitlabHost, corsProxy);

	// GitLab Events `after`/`before` are *exclusive*, so widen the window by a
	// day on each side; the inclusive client-side filter below trims the extras.
	const after = shiftDay(weekStart, -1);
	const before = shiftDay(weekEnd, 1);

	// Page through events at the max page size until exhausted, with a safety
	// cap so a misbehaving instance can't loop forever (10 pages × 100 = 1000).
	const PER_PAGE = 100;
	const MAX_PAGES = 10;
	const allEvents: GitLabEvent[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		let res: Response;
		try {
			const params = new URLSearchParams({
				per_page: String(PER_PAGE),
				page: String(page),
				after,
				before,
			});
			res = await fetch(`${baseUrl}/api/v4/events?${params}`, {
				headers: {
					'PRIVATE-TOKEN': gitlabToken,
					Accept: 'application/json',
				},
				signal,
			});
		} catch (error) {
			// A rich ServiceError thrown elsewhere must propagate unchanged; an
			// abort must surface as an abort. Only genuine network/throw errors
			// get the "could not reach host" wrapping.
			if (error instanceof ServiceError) throw error;
			if (error instanceof DOMException && error.name === 'AbortError') {
				throw error;
			}
			if (error instanceof Error && error.name === 'AbortError') throw error;
			throw fromRichMessage(
				'GitLab',
				undefined,
				describeGitlabConnectionError(error, cleanHost),
			);
		}

		if (!res.ok) {
			throw fromRichMessage(
				'GitLab',
				res.status,
				await describeGitlabErrorResponse(res, cleanHost),
			);
		}

		const events = (await res.json()) as GitLabEvent[];
		allEvents.push(...events);
		if (events.length < PER_PAGE) break;
	}

	// Group activities by (date, issueKey, activityType)
	const grouped = new Map<string, ActivityEntry>();

	for (const event of allEvents) {
		const day = dateOnly(event.created_at);
		if (day < weekStart || day > weekEnd) continue;

		if (isPushEvent(event.action_name)) {
			const pushData = event.push_data;
			if (!pushData) continue;

			const branchKeys = pushData.ref ? extractJiraKeys(pushData.ref) : [];
			const titleKeys = pushData.commit_title
				? extractJiraKeys(pushData.commit_title)
				: [];
			const keys = [...new Set([...branchKeys, ...titleKeys])];
			if (keys.length === 0) continue;

			// A push's commit_count must be counted once, not once per key.
			// Attribute commits across the referenced keys: distribute the base
			// share to every key and hand the remainder to the leading keys so
			// the per-push total matches commit_count exactly.
			const commits = pushData.commit_count || 1;
			const base = Math.floor(commits / keys.length);
			let remainder = commits % keys.length;
			for (const key of keys) {
				const entry = getEntry(grouped, `${day}::${key}::push`, 'push');
				entry.count += base + (remainder > 0 ? 1 : 0);
				if (remainder > 0) remainder--;
				if (pushData.commit_title) {
					entry.reasons.push(pushData.commit_title.slice(0, 80));
				}
			}
		} else if (isMrActionEvent(event)) {
			const title = event.target_title || '';
			const keys = extractJiraKeys(title);
			if (keys.length === 0) continue;

			const label = event.action_name;
			for (const key of keys) {
				const entry = getEntry(
					grouped,
					`${day}::${key}::mr-action`,
					'mr-action',
				);
				entry.count++;
				entry.reasons.push(`${label} MR: ${title.slice(0, 60)}`);
			}
		} else if (isReviewEvent(event)) {
			const title = event.target_title || event.note?.body || '';
			const noteBody = event.note?.body || '';
			const keys = [...extractJiraKeys(title), ...extractJiraKeys(noteBody)];
			const uniqueKeys = [...new Set(keys)];
			if (uniqueKeys.length === 0) continue;

			for (const key of uniqueKeys) {
				const entry = getEntry(grouped, `${day}::${key}::review`, 'review');
				entry.count++;
				const snippet =
					noteBody.length > 60
						? `${noteBody.slice(0, 57)}...`
						: noteBody || title.slice(0, 60);
				entry.reasons.push(snippet);
			}
		}
	}

	// Convert grouped entries to suggestions, merging activity types per (day, issueKey)
	const merged = new Map<
		string,
		{
			seconds: number;
			confidence: 'high' | 'medium' | 'low';
			reasons: string[];
		}
	>();

	for (const [mapKey, entry] of grouped) {
		const parts = mapKey.split('::');
		const day = parts[0];
		const issueKey = parts[1];
		const dayIssueKey = `${day}::${issueKey}`;

		const seconds = estimateSeconds(entry.type, entry.count);
		const confidence = estimateConfidence(entry.type, entry.count);

		const existing = merged.get(dayIssueKey);
		if (existing) {
			existing.seconds += seconds;
			existing.reasons.push(formatReason(entry));
			// Upgrade confidence
			const rank = { high: 2, medium: 1, low: 0 };
			if (rank[confidence] > rank[existing.confidence]) {
				existing.confidence = confidence;
			}
		} else {
			merged.set(dayIssueKey, {
				seconds,
				confidence,
				reasons: [formatReason(entry)],
			});
		}
	}

	const suggestions: WorklogSuggestion[] = [];

	for (const [dayIssueKey, data] of merged) {
		const [day, issueKey] = dayIssueKey.split('::');
		const cappedSeconds = Math.min(data.seconds, 6 * 3600);
		const hours = cappedSeconds / 3600;

		suggestions.push({
			id: `gitlab-${issueKey}-${day}`,
			source: 'gitlab',
			issueKey,
			date: day,
			suggestedTimeSpent:
				hours >= 1
					? `${Math.floor(hours)}h${hours % 1 >= 0.5 ? ' 30m' : ''}`
					: '30m',
			suggestedSeconds: cappedSeconds,
			confidence: data.confidence,
			reason: data.reasons.join(' + '),
			logged: false,
		});
	}

	return suggestions;
}

export { JIRA_KEY_RE, extractJiraKeys };
