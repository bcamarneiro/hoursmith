/**
 * Cron-triggered absence polling for Hoursmith Premium (ADA-604).
 *
 * Runs every 15 minutes via Vercel Cron. Iterates all enabled ICS feeds,
 * fetches + parses each one, expands recurring events, resolves email-based
 * assignments to user IDs, and upserts the resulting absence_records.
 *
 * Nationwide holidays (no matching assignment) fan out to every known profile.
 *
 * Config: triggered by Vercel Cron — handler verifies the `x-vercel-cron`
 * header as a defense-in-depth measure.
 *
 * Linear: ADA-604.
 */

import { type SupabaseAdminClient, defaultSupabaseAdmin } from '../../_lib/supabaseAdmin';
import type {
	AbsenceRecordUpsert,
	CalendarFeedRow,
	ProfileRow,
} from '../../_lib/supabaseAdmin';
import {
	type AbsenceKind,
	type ProcessFeedResult,
	fetchAndParseFeed,
	expandFeedForUsers,
	mergeAbsenceResults,
	toLocalDateString,
} from '../../_lib/icsParser';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How far ahead (in days) to poll. We fetch from today-1 to today+N. */
const LOOKAHEAD_DAYS = 90;

/**
 * Vercel Cron secret. Set to a random token in production; verified against
 * the `x-vercel-cron` header. When unset (dev/CI) the check is skipped so
 * the handler can be invoked manually for testing.
 */
function cronSecret(): string | undefined {
	return process.env.CRON_SECRET;
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface AbsencePollDeps {
	supabase?: SupabaseAdminClient;
	fetchAndParseFeed?: typeof fetchAndParseFeed;
	expandFeedForUsers?: typeof expandFeedForUsers;
	mergeAbsenceResults?: typeof mergeAbsenceResults;
	now?: Date;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export default async function handler(request: Request): Promise<Response> {
	return handleAbsencePoll(request);
}

export async function handleAbsencePoll(
	request: Request,
	deps: AbsencePollDeps = {},
): Promise<Response> {
	const start = Date.now();

	// Only accept POST (Vercel Cron sends POST)
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	// Verify Vercel Cron header
	const secret = cronSecret();
	if (secret) {
		const cronHeader = request.headers.get('x-vercel-cron');
		if (cronHeader !== secret) {
			console.warn(
				JSON.stringify({
					ts: new Date().toISOString(),
					svc: 'hoursmith-absence-poll',
					code: 'invalid_cron_secret',
					status: 403,
				}),
			);
			return jsonResponse(403, { error: 'invalid_cron_secret' });
		}
	}

	// Resolve deps
	const supabase = deps.supabase ?? defaultSupabaseAdmin();
	const fetchFeed = deps.fetchAndParseFeed ?? fetchAndParseFeed;
	const expand = deps.expandFeedForUsers ?? expandFeedForUsers;
	const merge = deps.mergeAbsenceResults ?? mergeAbsenceResults;
	const now = deps.now ?? new Date();

	// Calculate date range
	const rangeStart = toLocalDateString(now);
	const rangeEnd = toLocalDateString(
		new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000),
	);

	try {
		// 1. Fetch all enabled feeds
		const feeds = await supabase.getAllEnabledFeeds();
		if (feeds.length === 0) {
			logResult({ code: 'ok', feedsProcessed: 0, durationMs: Date.now() - start });
			return jsonResponse(200, { ok: true, feedsProcessed: 0 });
		}

		// 2. Pre-fetch all profiles for email→userId resolution
		const allProfiles = await supabase.getAllProfiles();
		const emailToUserId = new Map<string, string>();
		for (const p of allProfiles) {
			emailToUserId.set(p.email.trim().toLowerCase(), p.id);
		}

		// 3. Process each feed
		const allEntries: {
			email: string;
			date: string;
			summary: string;
			kind: AbsenceKind;
		}[] = [];

		let feedErrors = 0;

		for (const feed of feeds) {
			const feedOwnerEmail = resolveFeedOwnerEmail(feed, allProfiles);
			if (!feedOwnerEmail) {
				feedErrors++;
				console.warn(
					JSON.stringify({
						ts: new Date().toISOString(),
						svc: 'hoursmith-absence-poll',
						code: 'no_feed_owner',
						feed_id: feed.id,
						user_id: feed.user_id,
					}),
				);
				continue;
			}

			// Fetch and parse the ICS
			const parsed = await fetchFeed(feed.url);
			if (!parsed) {
				feedErrors++;
				console.warn(
					JSON.stringify({
						ts: new Date().toISOString(),
						svc: 'hoursmith-absence-poll',
						code: 'fetch_failed',
						feed_id: feed.id,
						url: feed.url,
					}),
				);
				continue;
			}

			// Build the process feed result
			const processResult: ProcessFeedResult = {
				feedUrl: feed.url,
				feedType: feed.type,
				label: feed.label,
				absenceAttribution: feed.absence_attribution,
				titleFilter: feed.title_filter,
				events: parsed.events,
			};

			// Fetch assignments for this feed owner
			let assignments: { pattern: string; userEmails: string[] }[] = [];
			try {
				const rows = await supabase.getAbsenceAssignments(feed.user_id);
				assignments = rows.map((r) => ({
					pattern: r.pattern,
					userEmails: r.user_emails,
				}));
			} catch {
				// No assignments or error — treat as empty
			}

			// Expand events into per-user entries
			const entries = expand(processResult, rangeStart, rangeEnd, feedOwnerEmail, assignments);
			allEntries.push(...entries);
		}

		// 4. Merge per-user results
		const merged = merge(allEntries);

		// 5. Resolve email → userId and fan out nationwide holidays
		const allUserIds = new Set(emailToUserId.values());
		const userIdEntries = new Map<string, AbsenceRecordUpsert[]>();

		for (const [email, dates] of merged) {
			// Determine target user IDs
			let targetUserIds: string[];

			if (email === '*') {
				// Nationwide holiday — fan out to every user
				targetUserIds = [...allUserIds];
			} else {
				const uid = emailToUserId.get(email);
				if (!uid) {
					// Unknown email — skip (could be a stale assignment)
					continue;
				}
				targetUserIds = [uid];
			}

			for (const uid of targetUserIds) {
				if (!userIdEntries.has(uid)) {
					userIdEntries.set(uid, []);
				}
				const userRecords = userIdEntries.get(uid)!;
				for (const [, day] of dates) {
					userRecords.push({
						user_id: uid,
						feed_id: null, // records are merged across feeds, so a single feed_id is not meaningful
						date: day.date,
						kind: day.kind,
						summary: day.summary,
						reasons: [day.summary],
						source: 'cron',
					});
				}
			}
		}

		// 6. Upsert absence records per user
		let totalRecords = 0;
		for (const [uid, records] of userIdEntries) {
			try {
				await supabase.replaceAbsenceRecords(uid, rangeStart, rangeEnd, records);
				totalRecords += records.length;
			} catch (err) {
				console.error(
					JSON.stringify({
						ts: new Date().toISOString(),
						svc: 'hoursmith-absence-poll',
						code: 'upsert_failed',
						user_id: uid,
						error: (err as Error).message,
					}),
				);
			}
		}

		logResult({
			code: 'ok',
			feedsProcessed: feeds.length,
			feedErrors,
			totalRecords,
			durationMs: Date.now() - start,
		});

		return jsonResponse(200, {
			ok: true,
			feedsProcessed: feeds.length,
			feedErrors,
			totalRecords,
			durationMs: Date.now() - start,
		});
	} catch (err) {
		console.error(
			JSON.stringify({
				ts: new Date().toISOString(),
				svc: 'hoursmith-absence-poll',
				code: 'unexpected_error',
				error: (err as Error).message,
				durationMs: Date.now() - start,
			}),
		);
		return jsonResponse(500, { error: 'internal_error' });
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a feed's owner email from the profiles list.
 */
function resolveFeedOwnerEmail(
	feed: CalendarFeedRow,
	profiles: ProfileRow[],
): string | null {
	for (const p of profiles) {
		if (p.id === feed.user_id) return p.email;
	}
	return null;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

interface PollLogFields {
	code: string;
	feedsProcessed?: number;
	feedErrors?: number;
	totalRecords?: number;
	durationMs: number;
}

function logResult(fields: PollLogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-absence-poll',
			...fields,
		}),
	);
}
