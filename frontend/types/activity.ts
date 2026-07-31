/**
 * Shared contracts for "recent activity" data (ADA-654).
 *
 * Jira's REST API shapes (changelog expansion on issue search) are declared
 * here so services, hooks and future UI consumers agree on the same wire
 * format, plus the normalized activity record the app consumes downstream.
 *
 * Jira changelog shape (from `expand=changelog` on /rest/api/3/search/jql and
 * /rest/api/2/search):
 *
 *   {
 *     histories: [
 *       {
 *         id: "12345",
 *         author: { emailAddress, displayName },
 *         created: "2025-10-15T09:00:00.000+0000",
 *         items: [
 *           { field: "status", fromString: "To Do", toString: "In Progress" },
 *           { field: "comment", fromString: null, toString: "…" }
 *         ]
 *       }
 *     ]
 *   }
 */

/** A single field change inside one changelog history entry. */
export interface JiraChangelogItem {
	field: string;
	fromString?: string | null;
	toString?: string | null;
}

/** One changelog history entry: an author, a timestamp, and the fields changed. */
export interface JiraChangelogHistory {
	created: string;
	author?: {
		emailAddress?: string;
		displayName?: string;
	};
	items?: JiraChangelogItem[];
}

/** The `changelog` expansion returned on Jira issue search. */
export interface JiraChangelog {
	histories?: JiraChangelogHistory[];
}

/** An issue as returned by search with `expand=changelog`. */
export interface JiraIssueWithChangelog {
	key: string;
	fields: { summary?: string };
	changelog?: JiraChangelog;
}

/**
 * Normalized per-day activity record for one issue.
 *
 * This is the public output contract of the recent-activity data fetch —
 * consumers (worklog suggestion builders, dashboard panels) should depend on
 * this shape rather than on raw Jira changelog structure.
 */
export interface JiraActivityItem {
	issueKey: string;
	issueSummary?: string;
	/** ISO date (YYYY-MM-DD) the activity happened. */
	date: string;
	/** Number of status transitions by the current user on that day. */
	transitions: number;
	/** Number of comments added by the current user on that day. */
	comments: number;
}
