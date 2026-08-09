import { addDaysToIsoDate, parseIsoDateLocal } from './date';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Determine the date range for the standup view.
 *
 * - Tuesday–Friday → yesterday only
 * - Monday → Friday through Sunday (the weekend gap)
 * - Saturday → Friday (yesterday)
 * - Sunday → Friday (skip Saturday)
 *
 * Returns `{ start, end }` as YYYY-MM-DD strings (inclusive).
 */
export function getStandupDateRange(today: Date = new Date()): {
	start: string;
	end: string;
	label: string;
} {
	const dayOfWeek = today.getDay(); // 0=Sun … 6=Sat

	if (dayOfWeek === 1) {
		// Monday → show Friday through Sunday
		const friday = addDaysToIsoDate(toIsoDate(today), -3);
		const sunday = addDaysToIsoDate(toIsoDate(today), -1);
		return { start: friday, end: sunday, label: 'Friday – Sunday' };
	}

	if (dayOfWeek === 6) {
		// Saturday → show Friday
		const friday = addDaysToIsoDate(toIsoDate(today), -1);
		return { start: friday, end: friday, label: 'Friday' };
	}

	if (dayOfWeek === 0) {
		// Sunday → show Friday
		const friday = addDaysToIsoDate(toIsoDate(today), -2);
		return { start: friday, end: friday, label: 'Friday' };
	}

	// Tuesday–Friday → yesterday
	const yesterday = addDaysToIsoDate(toIsoDate(today), -1);
	const dayLabel = DAY_LABELS[parseIsoDateLocal(yesterday).getDay()];
	return { start: yesterday, end: yesterday, label: dayLabel };
}

function toIsoDate(d: Date): string {
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function formatDuration(seconds: number): string {
	const totalMinutes = Math.round(seconds / 60);
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	if (m === 0) return `${h}h`;
	if (h === 0) return `${m}m`;
	return `${h}h ${m}m`;
}

interface WorklogEntry {
	date: string;
	issueKey: string;
	issueSummary?: string;
	timeSpentSeconds: number;
}

/**
 * Generate a plain-text standup summary: "what I worked on" for a given date
 * range, grouped by issue. Designed to be copied into a daily standup channel.
 *
 * Format:
 *   PROJ-123 - Issue summary (2h)
 *   PROJ-456 - Another task (1h 30m)
 *   Total: 3h 30m
 */
export function generateStandupSummary(
	worklogs: WorklogEntry[],
	startDate: string,
	endDate: string,
): string {
	// Filter worklogs to the standup date range
	const filtered = worklogs.filter(
		(wl) => wl.date >= startDate && wl.date <= endDate,
	);

	if (filtered.length === 0) {
		return 'No worklogs recorded.';
	}

	// Group by issueKey
	const issueMap = new Map<
		string,
		{ summary?: string; totalSeconds: number }
	>();

	for (const wl of filtered) {
		let entry = issueMap.get(wl.issueKey);
		if (!entry) {
			entry = { summary: wl.issueSummary, totalSeconds: 0 };
			issueMap.set(wl.issueKey, entry);
		}
		entry.totalSeconds += wl.timeSpentSeconds;
		// Keep the latest non-empty summary
		if (wl.issueSummary && !entry.summary) {
			entry.summary = wl.issueSummary;
		}
	}

	// Sort by total time descending (matches weekSummary convention)
	const sortedIssues = [...issueMap.entries()].sort(([, a], [, b]) => {
		if (b.totalSeconds !== a.totalSeconds) {
			return b.totalSeconds - a.totalSeconds;
		}
		return 0;
	});

	const lines: string[] = [];
	let grandTotal = 0;

	for (const [issueKey, entry] of sortedIssues) {
		const title = entry.summary
			? `${issueKey} - ${entry.summary}`
			: issueKey;
		lines.push(`${title} (${formatDuration(entry.totalSeconds)})`);
		grandTotal += entry.totalSeconds;
	}

	lines.push('');
	lines.push(`Total: ${formatDuration(grandTotal)}`);

	return lines.join('\n');
}
