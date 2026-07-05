import type {
	MemberCompleteness,
	PeriodInfo,
	ReminderSettings,
} from './types.js';

/**
 * Persistence for the reminder substrate (ADA-552). A dedicated store rather
 * than bloating `SupabaseAdminClient` — the reminder concern stays self-
 * contained and the fetch impl mirrors the other `_lib` clients. Tests inject a
 * fake through {@link RemindersStore}.
 *
 * Privacy: only what the migration allows — a per-member/period complete flag +
 * delivery token. Never worklog detail.
 */

export interface ReminderSettingsRow {
	user_id: string;
	enabled: boolean;
	member_nudge: boolean;
	lead_digest: boolean;
	lead_email: string | null;
	team_name: string | null;
}

/** One member/period the lead's browser reported as still incomplete. */
export interface ReminderStateInput {
	memberEmail: string;
	displayName: string;
	periodKey: string;
	complete: boolean;
	onLeave: boolean;
	/** Client may supply a stable token; the store mints one when absent. */
	deliveryToken?: string;
}

/** A due (incomplete, unsent) row the cron will act on. */
export interface DueStateRow {
	owner_user_id: string;
	member_email: string;
	display_name: string;
	period_key: string;
	on_leave: boolean;
	delivery_token: string;
}

export interface RemindersStore {
	upsertSettings(userId: string, settings: ReminderSettings): Promise<void>;
	upsertStates(userId: string, states: ReminderStateInput[]): Promise<void>;
	getSettings(userId: string): Promise<ReminderSettingsRow | null>;
	/** Incomplete, not-yet-sent rows across all leads (cron scan). */
	listDue(): Promise<DueStateRow[]>;
	markSent(tokens: string[]): Promise<void>;
}

/** Turn an opaque period key into email-facing labels. */
export function periodInfoFromKey(periodKey: string): PeriodInfo {
	if (/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) {
		const [y, m, d] = periodKey.split('-').map(Number);
		const label = new Intl.DateTimeFormat('en-GB', {
			day: 'numeric',
			month: 'short',
		}).format(new Date(y, m - 1, d));
		return { label: `the week of ${label}` };
	}
	return { label: periodKey };
}

/** Map a due row to the selection engine's member shape (always incomplete). */
export function dueRowToMember(row: DueStateRow): MemberCompleteness {
	return {
		email: row.member_email,
		displayName: row.display_name || row.member_email,
		complete: false,
		onLeave: row.on_leave,
		deliveryToken: row.delivery_token,
	};
}

function newToken(): string {
	return crypto.randomUUID();
}

class FetchRemindersStore implements RemindersStore {
	constructor(
		private readonly url: string,
		private readonly serviceRoleKey: string,
	) {}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		return {
			apikey: this.serviceRoleKey,
			authorization: `Bearer ${this.serviceRoleKey}`,
			accept: 'application/json',
			'content-type': 'application/json',
			...extra,
		};
	}

	async upsertSettings(
		userId: string,
		settings: ReminderSettings,
	): Promise<void> {
		const row: ReminderSettingsRow & { updated_at: string } = {
			user_id: userId,
			enabled: settings.enabled,
			member_nudge: settings.memberNudge,
			lead_digest: settings.leadDigest,
			lead_email: settings.leadEmail ?? null,
			team_name: settings.teamName ?? null,
			updated_at: new Date().toISOString(),
		};
		const res = await fetch(`${this.url}/rest/v1/reminder_settings`, {
			method: 'POST',
			headers: this.headers({ prefer: 'resolution=merge-duplicates' }),
			body: JSON.stringify(row),
		});
		if (!res.ok) {
			throw new Error(`remindersStore.upsertSettings failed: ${res.status}`);
		}
	}

	async upsertStates(
		userId: string,
		states: ReminderStateInput[],
	): Promise<void> {
		if (states.length === 0) return;
		const rows = states.map((state) => ({
			owner_user_id: userId,
			member_email: state.memberEmail,
			display_name: state.displayName,
			period_key: state.periodKey,
			complete: state.complete,
			on_leave: state.onLeave,
			delivery_token: state.deliveryToken ?? newToken(),
			updated_at: new Date().toISOString(),
		}));
		const res = await fetch(`${this.url}/rest/v1/reminder_completeness_state`, {
			method: 'POST',
			headers: this.headers({
				prefer: 'resolution=merge-duplicates,return=minimal',
			}),
			body: JSON.stringify(rows),
		});
		if (!res.ok) {
			throw new Error(`remindersStore.upsertStates failed: ${res.status}`);
		}
	}

	async getSettings(userId: string): Promise<ReminderSettingsRow | null> {
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			select: 'user_id,enabled,member_nudge,lead_digest,lead_email,team_name',
		});
		const res = await fetch(
			`${this.url}/rest/v1/reminder_settings?${params.toString()}`,
			{ headers: this.headers() },
		);
		if (!res.ok) {
			throw new Error(`remindersStore.getSettings failed: ${res.status}`);
		}
		const rows = (await res.json()) as ReminderSettingsRow[];
		return rows[0] ?? null;
	}

	async listDue(): Promise<DueStateRow[]> {
		const params = new URLSearchParams({
			complete: 'eq.false',
			sent_at: 'is.null',
			select:
				'owner_user_id,member_email,display_name,period_key,on_leave,delivery_token',
		});
		const res = await fetch(
			`${this.url}/rest/v1/reminder_completeness_state?${params.toString()}`,
			{ headers: this.headers() },
		);
		if (!res.ok) {
			throw new Error(`remindersStore.listDue failed: ${res.status}`);
		}
		return (await res.json()) as DueStateRow[];
	}

	async markSent(tokens: string[]): Promise<void> {
		if (tokens.length === 0) return;
		const inList = `(${tokens.map((t) => `"${t}"`).join(',')})`;
		const params = new URLSearchParams({ delivery_token: `in.${inList}` });
		const res = await fetch(
			`${this.url}/rest/v1/reminder_completeness_state?${params.toString()}`,
			{
				method: 'PATCH',
				headers: this.headers({ prefer: 'return=minimal' }),
				body: JSON.stringify({ sent_at: new Date().toISOString() }),
			},
		);
		if (!res.ok) {
			throw new Error(`remindersStore.markSent failed: ${res.status}`);
		}
	}
}

export function defaultRemindersStore(): RemindersStore {
	const url = process.env.SUPABASE_URL;
	const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !serviceRoleKey) {
		throw new Error(
			'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for reminders.',
		);
	}
	return new FetchRemindersStore(url, serviceRoleKey);
}
