import { addDaysToIsoDate } from '../react/utils/date';
import { classifyWorklog } from '../react/utils/worklogClassifier';
import type { Config } from '../stores/useConfigStore';
import { searchAllIssues } from './jiraSearch';

export interface TeamMemberSummary {
	email: string;
	displayName: string;
	dailyHours: Map<string, number>;
	totalSeconds: number;
	targetSeconds: number;
	gapSeconds: number;
	/** Seconds among `totalSeconds` whose `loggedOn` falls in the visible week
	 *  but were intended for an earlier date (Pattern A or jira-native).
	 *  Drives the `Backdated (h)` column in the team CSV. Optional so synthetic
	 *  test fixtures and other producers (e.g. `teamReports.buildTeamSummaries`)
	 *  can omit it; consumers default to 0. */
	backdatedSeconds?: number;
	backdatedCount?: number;
	/** Dates (YYYY-MM-DD) where the member logged work on a PTO/holiday day.
	 *  Drives the "worked on PTO" badge in the team weekly view. */
	workedOnPtoDates?: string[];
}

const SECONDS_PER_DAY = 28800; // 8h

function buildUrl(config: Config, path: string): string {
	const base = config.corsProxy
		? `${config.corsProxy.replace(/\/$/, '')}/https://${config.jiraHost}`
		: `https://${config.jiraHost}`;
	return `${base}${path}`;
}

/** Format a local Date as YYYY-MM-DD without UTC conversion */
function toDateStr(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function isWeekday(dateStr: string): boolean {
	const d = new Date(dateStr);
	const day = d.getDay();
	return day !== 0 && day !== 6;
}

function getWeekdaysBetween(start: string, end: string): string[] {
	const days: string[] = [];
	const current = new Date(start);
	const last = new Date(end);
	while (current <= last) {
		const dateStr = toDateStr(current);
		if (isWeekday(dateStr)) {
			days.push(dateStr);
		}
		current.setDate(current.getDate() + 1);
	}
	return days;
}

interface WorklogEntry {
	author: { emailAddress?: string; displayName?: string };
	started: string;
	created?: string;
	comment?: string;
	timeSpentSeconds: number;
}

interface SearchIssue {
	key: string;
	fields: {
		worklog?: {
			startAt: number;
			maxResults: number;
			total: number;
			worklogs: WorklogEntry[];
		};
	};
}

export async function fetchTeamWorklogs(
	config: Config,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<TeamMemberSummary[]> {
	if (!config.jiraHost || !config.apiToken) return [];

	const headers: HeadersInit = {
		Authorization: `Bearer ${config.apiToken}`,
		Accept: 'application/json',
		'X-Atlassian-Token': 'no-check',
	};

	// Widen the JQL window by ±1 week so cross-week backdated worklogs (those
	// whose `started` falls outside the visible week but whose classifier
	// `loggedOn` is inside) are still fetched. Final bucketing happens
	// client-side via `classifyWorklog(wl).loggedOn`.
	const fetchStart = addDaysToIsoDate(weekStart, -7);
	const fetchEnd = addDaysToIsoDate(weekEnd, 7);
	const jql = `worklogDate >= "${fetchStart}" AND worklogDate <= "${fetchEnd}"`;

	// Step 1: Search with embedded worklogs
	const issues = await searchAllIssues<SearchIssue>(
		config,
		{ jql, fields: 'key,worklog', maxResults: 50 },
		{ signal },
	);

	// Step 2: Use embedded worklogs when complete, fetch separately only for truncated
	const allWorklogs: WorklogEntry[] = [];
	const truncatedKeys: string[] = [];

	for (const issue of issues) {
		const embedded = issue.fields.worklog;
		if (!embedded) {
			truncatedKeys.push(issue.key);
			continue;
		}

		if (embedded.total <= embedded.maxResults) {
			// All worklogs are in the embedded response — filter via classifier
			// against the (canonical, narrow) visible week.
			for (const wl of embedded.worklogs) {
				const day = classifyWorklog(wl).loggedOn;
				if (day && day >= weekStart && day <= weekEnd) {
					allWorklogs.push(wl);
				}
			}
		} else {
			truncatedKeys.push(issue.key);
		}
	}

	// Fetch full worklogs only for truncated issues, using the WIDER window
	// so cross-week backdates can still surface client-side.
	if (truncatedKeys.length > 0) {
		const fetchStartMillis = new Date(fetchStart).getTime();
		const fetchEndMillis = new Date(`${fetchEnd}T23:59:59.999`).getTime();
		const batchSize = 10;

		for (let i = 0; i < truncatedKeys.length; i += batchSize) {
			const batch = truncatedKeys.slice(i, i + batchSize);
			const results = await Promise.all(
				batch.map(async (key) => {
					try {
						const res = await fetch(
							buildUrl(
								config,
								`/rest/api/2/issue/${key}/worklog?startedAfter=${fetchStartMillis}&startedBefore=${fetchEndMillis}`,
							),
							{ headers, signal },
						);
						if (!res.ok) return [];
						const data = (await res.json()) as {
							worklogs: WorklogEntry[];
						};
						return data.worklogs || [];
					} catch {
						return [];
					}
				}),
			);
			for (const worklogs of results) {
				allWorklogs.push(...worklogs);
			}
		}
	}

	// Parse the allowed users filter
	const allowedSet = config.allowedUsers
		? new Set(
				config.allowedUsers
					.split(',')
					.map((e) => e.trim().toLowerCase())
					.filter(Boolean),
			)
		: null;

	// Collect worklogs grouped by author email, bucketed via classifier
	// so Pattern A and Pattern B backdates land under their `loggedOn`.
	const memberMap = new Map<
		string,
		{
			displayName: string;
			dailySeconds: Map<string, number>;
			backdatedSeconds: number;
			backdatedCount: number;
		}
	>();

	for (const wl of allWorklogs) {
		const email = wl.author?.emailAddress?.toLowerCase();
		if (!email) continue;

		// Filter by allowed users if configured
		if (allowedSet && !allowedSet.has(email)) continue;

		const c = classifyWorklog(wl);
		const day = c.loggedOn;
		if (!day || day < weekStart || day > weekEnd) continue;

		let member = memberMap.get(email);
		if (!member) {
			member = {
				displayName: wl.author.displayName || email,
				dailySeconds: new Map(),
				backdatedSeconds: 0,
				backdatedCount: 0,
			};
			memberMap.set(email, member);
		}

		if (c.isBackdated) {
			// Backdated worklogs are tracked separately for the side-panel
			// breakdown but do NOT contribute to daily/weekly totals or
			// compliance % (project-wide invariant — see AGENTS.md).
			member.backdatedSeconds += wl.timeSpentSeconds;
			member.backdatedCount += 1;
			continue;
		}

		const existing = member.dailySeconds.get(day) || 0;
		member.dailySeconds.set(day, existing + wl.timeSpentSeconds);
	}

	// Ensure all allowed users appear even with zero hours
	if (allowedSet) {
		for (const email of allowedSet) {
			if (!memberMap.has(email)) {
				memberMap.set(email, {
					displayName: email,
					dailySeconds: new Map(),
					backdatedSeconds: 0,
					backdatedCount: 0,
				});
			}
		}
	}

	// Convert to TeamMemberSummary[]
	// For the current/future week, cap the target at today so we don't
	// penalise people for days that haven't happened yet.
	const today = toDateStr(new Date());
	const effectiveEnd = weekEnd > today ? today : weekEnd;
	const weekdays = getWeekdaysBetween(weekStart, weekEnd);
	const targetWeekdays = getWeekdaysBetween(weekStart, effectiveEnd);
	const targetSeconds = targetWeekdays.length * SECONDS_PER_DAY;

	const summaries: TeamMemberSummary[] = [];

	for (const [email, member] of memberMap) {
		const dailyHours = new Map<string, number>();
		const totalSeconds = [...member.dailySeconds.values()].reduce(
			(sum, seconds) => sum + seconds,
			0,
		);

		for (const day of weekdays) {
			const seconds = member.dailySeconds.get(day) || 0;
			dailyHours.set(day, seconds / 3600);
		}

		const gapSeconds = Math.max(0, targetSeconds - totalSeconds);

		summaries.push({
			email,
			displayName: member.displayName,
			dailyHours,
			totalSeconds,
			targetSeconds,
			gapSeconds,
			backdatedSeconds: member.backdatedSeconds,
			backdatedCount: member.backdatedCount,
		});
	}

	// Sort by display name
	summaries.sort((a, b) => a.displayName.localeCompare(b.displayName));

	return summaries;
}
