// frontend/services/githubService.ts
import type { WorklogSuggestion } from '../../types/Suggestion';
import { extractJiraKeys } from './jiraKeys';
import { fromRichMessage, ServiceError } from './serviceErrors';

const GITHUB_API_VERSION = '2022-11-28';

type ActivityType = 'push' | 'pr-action' | 'review';

interface ActivityEntry {
	type: ActivityType;
	count: number;
	reasons: string[];
}

// Mirror gitlabService time heuristics.
const TIME_ESTIMATES: Record<ActivityType, { perUnit: number; max: number }> = {
	push: { perUnit: 3600, max: 4 * 3600 },
	'pr-action': { perUnit: 1800, max: 2 * 3600 },
	review: { perUnit: 900, max: 2 * 3600 },
};

interface GithubEvent {
	type: string;
	created_at: string;
	payload?: {
		ref?: string;
		commits?: { message?: string }[];
		action?: string;
		pull_request?: { title?: string; head?: { ref?: string } };
		issue?: { title?: string; pull_request?: unknown };
		comment?: { body?: string };
		review?: { body?: string };
	};
}

export function normalizeGithubHost(host: string): string {
	return host.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * github.com → `https://api.github.com` (called directly; CORS is open).
 * GHES → `https://<host>/api/v3`, optionally behind the user CORS proxy
 * (GHES CORS is not guaranteed). The host field is seeded in config but not
 * surfaced in the UI yet, so today this always returns the github.com base.
 */
export function buildGithubApiBase(host: string, corsProxy: string): string {
	const cleanHost = normalizeGithubHost(host);
	if (!cleanHost) return 'https://api.github.com';
	const origin = `https://${cleanHost}/api/v3`;
	return corsProxy ? `${corsProxy.replace(/\/$/, '')}/${origin}` : origin;
}

export function describeGithubConnectionError(
	error: unknown,
	host: string,
): string {
	const label = normalizeGithubHost(host) || 'github.com';
	if (
		error instanceof TypeError ||
		(error instanceof Error && /fetch|network/i.test(error.message))
	) {
		return `Could not reach ${label}. Check your network or token.`;
	}
	return error instanceof Error ? error.message : 'GitHub connection failed';
}

function headers(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': GITHUB_API_VERSION,
	};
}

function describeStatus(status: number, host: string): string {
	const label = normalizeGithubHost(host) || 'github.com';
	if (status === 401)
		return `GitHub rejected the token (401). Check it's active with repo + read:user scope.`;
	if (status === 403)
		return `GitHub denied access or rate-limited (403) on ${label}. Check scopes/SSO or retry shortly.`;
	return `GitHub API error on ${label}: ${status}.`;
}

export async function fetchGithubUser(
	token: string,
	host: string,
	corsProxy: string,
	signal?: AbortSignal,
): Promise<{ login: string; name: string | null }> {
	const base = buildGithubApiBase(host, corsProxy);
	let res: Response;
	try {
		res = await fetch(`${base}/user`, { headers: headers(token), signal });
	} catch (error) {
		if (error instanceof ServiceError) throw error;
		if (error instanceof Error && error.name === 'AbortError') throw error;
		throw fromRichMessage(
			'GitHub',
			undefined,
			describeGithubConnectionError(error, host),
		);
	}
	if (!res.ok) {
		throw fromRichMessage(
			'GitHub',
			res.status,
			describeStatus(res.status, host),
		);
	}
	const body = (await res.json()) as { login: string; name?: string | null };
	return { login: body.login, name: body.name ?? null };
}

function dateOnly(iso: string): string {
	return iso.slice(0, 10);
}

function estimateSeconds(type: ActivityType, count: number): number {
	const { perUnit, max } = TIME_ESTIMATES[type];
	return Math.min(count * perUnit, max);
}

function estimateConfidence(
	type: ActivityType,
	count: number,
): 'high' | 'medium' | 'low' {
	if (type === 'push') return count >= 3 ? 'high' : 'medium';
	if (type === 'pr-action') return 'medium';
	return count >= 3 ? 'medium' : 'low';
}

function reasonLabel(type: ActivityType, count: number): string {
	if (type === 'push') return `${count} commit${count > 1 ? 's' : ''}`;
	if (type === 'pr-action') return `${count} PR action${count > 1 ? 's' : ''}`;
	return `${count} review comment${count > 1 ? 's' : ''}`;
}

const PR_ACTION_EVENTS = new Set(['PullRequestEvent']);
const REVIEW_EVENTS = new Set([
	'PullRequestReviewEvent',
	'PullRequestReviewCommentEvent',
	'IssueCommentEvent',
]);

/**
 * Fetch the user's recent GitHub events and extract Jira keys to build worklog
 * suggestions. Captures pushes, PR open/merge actions, and — crucially —
 * reviews/comments on ANY PR (incl. others'), which dev-status cannot attribute.
 */
export async function fetchGithubSuggestions(
	token: string,
	host: string,
	corsProxy: string,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<WorklogSuggestion[]> {
	if (!token) return [];

	const base = buildGithubApiBase(host, corsProxy);
	const { login } = await fetchGithubUser(token, host, corsProxy, signal);

	const PER_PAGE = 100;
	const MAX_PAGES = 5; // GitHub caps the events feed at ~300 events / 90 days.
	const events: GithubEvent[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		let res: Response;
		try {
			res = await fetch(
				`${base}/users/${encodeURIComponent(login)}/events?per_page=${PER_PAGE}&page=${page}`,
				{ headers: headers(token), signal },
			);
		} catch (error) {
			if (error instanceof ServiceError) throw error;
			if (error instanceof Error && error.name === 'AbortError') throw error;
			throw fromRichMessage(
				'GitHub',
				undefined,
				describeGithubConnectionError(error, host),
			);
		}
		if (!res.ok) {
			throw fromRichMessage(
				'GitHub',
				res.status,
				describeStatus(res.status, host),
			);
		}
		const batch = (await res.json()) as GithubEvent[];
		events.push(...batch);
		if (batch.length < PER_PAGE) break;
		// The feed is reverse-chronological; stop once the page's oldest event is
		// before the window.
		const oldest = batch[batch.length - 1]?.created_at;
		if (oldest && dateOnly(oldest) < weekStart) break;
	}

	const grouped = new Map<string, ActivityEntry>();
	const bump = (
		day: string,
		key: string,
		type: ActivityType,
		reason: string,
		by = 1,
	) => {
		const mapKey = `${day}::${key}::${type}`;
		let entry = grouped.get(mapKey);
		if (!entry) {
			entry = { type, count: 0, reasons: [] };
			grouped.set(mapKey, entry);
		}
		entry.count += by;
		if (reason) entry.reasons.push(reason.slice(0, 80));
	};

	for (const event of events) {
		const day = dateOnly(event.created_at);
		if (day < weekStart || day > weekEnd) continue;
		const p = event.payload ?? {};

		if (event.type === 'PushEvent') {
			const branchKeys = p.ref ? extractJiraKeys(p.ref) : [];
			const msgKeys = (p.commits ?? []).flatMap((c) =>
				extractJiraKeys(c.message ?? ''),
			);
			const keys = [...new Set([...branchKeys, ...msgKeys])];
			if (keys.length === 0) continue;
			const commits = (p.commits ?? []).length || 1;
			const base2 = Math.floor(commits / keys.length);
			let remainder = commits % keys.length;
			for (const key of keys) {
				bump(
					day,
					key,
					'push',
					p.commits?.[0]?.message ?? '',
					base2 + (remainder > 0 ? 1 : 0),
				);
				if (remainder > 0) remainder--;
			}
		} else if (PR_ACTION_EVENTS.has(event.type)) {
			const title = p.pull_request?.title ?? '';
			const ref = p.pull_request?.head?.ref ?? '';
			const keys = [
				...new Set([...extractJiraKeys(title), ...extractJiraKeys(ref)]),
			];
			if (keys.length === 0) continue;
			for (const key of keys) {
				bump(day, key, 'pr-action', `${p.action ?? 'updated'} PR: ${title}`);
			}
		} else if (REVIEW_EVENTS.has(event.type)) {
			// IssueCommentEvent fires for issues too; only count PR conversations.
			if (event.type === 'IssueCommentEvent' && !p.issue?.pull_request)
				continue;
			const title = p.pull_request?.title ?? p.issue?.title ?? '';
			const body = p.comment?.body ?? p.review?.body ?? '';
			const keys = [
				...new Set([...extractJiraKeys(title), ...extractJiraKeys(body)]),
			];
			if (keys.length === 0) continue;
			for (const key of keys) {
				bump(day, key, 'review', body || title);
			}
		}
	}

	// Merge activity types per (day, issueKey).
	const merged = new Map<
		string,
		{
			seconds: number;
			confidence: 'high' | 'medium' | 'low';
			reasons: string[];
		}
	>();
	const rank = { high: 2, medium: 1, low: 0 };
	for (const [mapKey, entry] of grouped) {
		const [day, issueKey] = mapKey.split('::');
		const dayIssueKey = `${day}::${issueKey}`;
		const seconds = estimateSeconds(entry.type, entry.count);
		const confidence = estimateConfidence(entry.type, entry.count);
		const reason = `${reasonLabel(entry.type, entry.count)}${
			entry.reasons.length ? `: ${entry.reasons.slice(0, 2).join('; ')}` : ''
		}`;
		const existing = merged.get(dayIssueKey);
		if (existing) {
			existing.seconds += seconds;
			existing.reasons.push(reason);
			if (rank[confidence] > rank[existing.confidence]) {
				existing.confidence = confidence;
			}
		} else {
			merged.set(dayIssueKey, { seconds, confidence, reasons: [reason] });
		}
	}

	const suggestions: WorklogSuggestion[] = [];
	for (const [dayIssueKey, data] of merged) {
		const [day, issueKey] = dayIssueKey.split('::');
		const capped = Math.min(data.seconds, 6 * 3600);
		const hours = capped / 3600;
		suggestions.push({
			id: `github-${issueKey}-${day}`,
			source: 'github',
			issueKey,
			date: day,
			suggestedTimeSpent:
				hours >= 1
					? `${Math.floor(hours)}h${hours % 1 >= 0.5 ? ' 30m' : ''}`
					: '30m',
			suggestedSeconds: capped,
			confidence: data.confidence,
			reason: data.reasons.join(' + '),
			logged: false,
		});
	}
	return suggestions;
}
