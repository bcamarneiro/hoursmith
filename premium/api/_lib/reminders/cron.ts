import { deliverReminders } from './deliver.js';
import { planReminders } from './selection.js';
import {
	type DueStateRow,
	dueRowToMember,
	periodInfoFromKey,
	type RemindersStore,
} from './store.js';
import type { EmailSender, ReminderSettings } from './types.js';

/**
 * The cron pass (ADA-552). Pure orchestration over injected store + sender, so
 * it's unit-testable end-to-end with fakes. The HTTP endpoint is a thin wrapper.
 *
 * Scan due (incomplete, unsent) rows → group by owner + period → for each
 * enabled owner, plan and deliver → mark sent so a re-run never double-sends.
 * A disabled owner's rows are left untouched (they may enable later).
 */

export interface CronSummary {
	owners: number;
	groups: number;
	sent: number;
	failed: number;
	skipped: number;
}

function toSettings(
	row: {
		enabled: boolean;
		member_nudge: boolean;
		lead_digest: boolean;
		lead_email: string | null;
		team_name: string | null;
	} | null,
): ReminderSettings | null {
	if (!row || !row.enabled) return null;
	return {
		enabled: true,
		memberNudge: row.member_nudge,
		leadDigest: row.lead_digest,
		leadEmail: row.lead_email ?? undefined,
		teamName: row.team_name ?? undefined,
	};
}

export async function runReminderCron(
	store: RemindersStore,
	sender: EmailSender,
): Promise<CronSummary> {
	const due = await store.listDue();
	const summary: CronSummary = {
		owners: 0,
		groups: 0,
		sent: 0,
		failed: 0,
		skipped: 0,
	};

	// Group by owner + period so each digest covers exactly one period.
	const groups = new Map<
		string,
		{ owner: string; period: string; rows: DueStateRow[] }
	>();
	for (const row of due) {
		const key = `${row.owner_user_id}::${row.period_key}`;
		const group = groups.get(key);
		if (group) {
			group.rows.push(row);
		} else {
			groups.set(key, {
				owner: row.owner_user_id,
				period: row.period_key,
				rows: [row],
			});
		}
	}

	const settingsCache = new Map<string, ReminderSettings | null>();
	const owners = new Set<string>();

	for (const group of groups.values()) {
		owners.add(group.owner);

		let settings = settingsCache.get(group.owner);
		if (settings === undefined) {
			settings = toSettings(await store.getSettings(group.owner));
			settingsCache.set(group.owner, settings);
		}
		if (!settings) continue;

		summary.groups += 1;
		const members = group.rows.map(dueRowToMember);
		const plan = planReminders(
			members,
			settings,
			periodInfoFromKey(group.period),
		);
		const result = await deliverReminders(plan, sender);
		summary.sent += result.sent;
		summary.failed += result.failed;
		summary.skipped += result.skipped;

		// Mark member nudges that went out; if the digest also went out cleanly,
		// mark the whole group so the digest isn't re-sent next run.
		const toMark = new Set(result.deliveredTokens);
		if (plan.leadDigest && result.failed === 0) {
			for (const row of group.rows) toMark.add(row.delivery_token);
		}
		if (toMark.size > 0) {
			await store.markSent([...toMark]);
		}
	}

	summary.owners = owners.size;
	return summary;
}
