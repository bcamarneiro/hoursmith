import { describe, expect, it } from 'vitest';
import { handleReminderCron } from '../../../cron/reminders.js';
import { handleReminderState } from '../../../reminders/state.js';
import { runReminderCron } from '../cron.js';
import {
	type DueStateRow,
	dueRowToMember,
	periodInfoFromKey,
	type ReminderSettingsRow,
	type ReminderStateInput,
	type RemindersStore,
} from '../store.js';
import type { EmailMessage, EmailSender } from '../types.js';

// --- fakes ---------------------------------------------------------------

class FakeStore implements RemindersStore {
	settingsWrites: Array<{ userId: string; settings: unknown }> = [];
	stateWrites: Array<{ userId: string; states: ReminderStateInput[] }> = [];
	marked: string[][] = [];
	constructor(
		private due: DueStateRow[] = [],
		private settingsByUser: Record<string, ReminderSettingsRow> = {},
	) {}
	async upsertSettings(userId: string, settings: unknown): Promise<void> {
		this.settingsWrites.push({ userId, settings });
	}
	async upsertStates(
		userId: string,
		states: ReminderStateInput[],
	): Promise<void> {
		this.stateWrites.push({ userId, states });
	}
	async getSettings(userId: string): Promise<ReminderSettingsRow | null> {
		return this.settingsByUser[userId] ?? null;
	}
	async listDue(): Promise<DueStateRow[]> {
		return this.due;
	}
	async markSent(tokens: string[]): Promise<void> {
		this.marked.push(tokens);
	}
}

function okSender(): { sender: EmailSender; sent: EmailMessage[] } {
	const sent: EmailMessage[] = [];
	return {
		sent,
		sender: {
			async send(message) {
				sent.push(message);
				return { ok: true, id: 'x' };
			},
		},
	};
}

function due(
	owner: string,
	email: string,
	token: string,
	period = '2026-03-02',
	onLeave = false,
): DueStateRow {
	return {
		owner_user_id: owner,
		member_email: email,
		display_name: email.split('@')[0],
		period_key: period,
		on_leave: onLeave,
		delivery_token: token,
	};
}

function settingsRow(
	userId: string,
	over: Partial<ReminderSettingsRow> = {},
): ReminderSettingsRow {
	return {
		user_id: userId,
		enabled: true,
		member_nudge: true,
		lead_digest: true,
		lead_email: 'lead@team.co',
		team_name: 'Team',
		...over,
	};
}

// --- helpers -------------------------------------------------------------

describe('periodInfoFromKey', () => {
	it('labels an ISO week-start date', () => {
		expect(periodInfoFromKey('2026-03-02').label).toBe('the week of 2 Mar');
	});
	it('passes an opaque key through unchanged', () => {
		expect(periodInfoFromKey('2026-W10').label).toBe('2026-W10');
	});
});

describe('dueRowToMember', () => {
	it('always maps to an incomplete member carrying the token', () => {
		const m = dueRowToMember(due('u1', 'a@b.co', 'tok'));
		expect(m).toMatchObject({
			email: 'a@b.co',
			complete: false,
			deliveryToken: 'tok',
		});
	});
});

// --- cron orchestration --------------------------------------------------

describe('runReminderCron', () => {
	it('nudges each behind member + the lead digest, then marks them sent', async () => {
		const store = new FakeStore(
			[due('u1', 'a@b.co', 't1'), due('u1', 'c@b.co', 't2')],
			{ u1: settingsRow('u1') },
		);
		const { sender, sent } = okSender();
		const summary = await runReminderCron(store, sender);
		// 2 member nudges + 1 digest
		expect(sent).toHaveLength(3);
		expect(summary).toMatchObject({ owners: 1, groups: 1, sent: 3, failed: 0 });
		// member tokens marked (digest sent cleanly → whole group anyway)
		expect(store.marked.flat().sort()).toEqual(['t1', 't2']);
	});

	it('leaves a disabled owner untouched', async () => {
		const store = new FakeStore([due('u1', 'a@b.co', 't1')], {
			u1: settingsRow('u1', { enabled: false }),
		});
		const { sender, sent } = okSender();
		const summary = await runReminderCron(store, sender);
		expect(sent).toHaveLength(0);
		expect(summary).toMatchObject({ owners: 1, groups: 0, sent: 0 });
		expect(store.marked).toHaveLength(0);
	});

	it('digest-only still marks the group so it never re-sends', async () => {
		const store = new FakeStore([due('u1', 'a@b.co', 't1')], {
			u1: settingsRow('u1', { member_nudge: false }),
		});
		const { sender, sent } = okSender();
		await runReminderCron(store, sender);
		expect(sent).toHaveLength(1); // digest only
		expect(store.marked.flat()).toEqual(['t1']);
	});

	it('skips a member on leave (never nudges PTO)', async () => {
		const store = new FakeStore(
			[due('u1', 'away@b.co', 't1', '2026-03-02', true)],
			{ u1: settingsRow('u1', { lead_digest: false }) },
		);
		const { sender, sent } = okSender();
		await runReminderCron(store, sender);
		expect(sent).toHaveLength(0);
	});
});

// --- cron endpoint -------------------------------------------------------

describe('handleReminderCron', () => {
	const cronReq = (secret?: string) =>
		new Request('https://x/api/cron/reminders', {
			method: 'GET',
			headers: secret ? { authorization: `Bearer ${secret}` } : {},
		});

	it('rejects a non-GET', async () => {
		const res = await handleReminderCron(
			new Request('https://x', { method: 'POST' }),
			{ secret: 's' },
		);
		expect(res.status).toBe(405);
	});

	it('500s when no CRON_SECRET is configured', async () => {
		const res = await handleReminderCron(cronReq('s'), { secret: undefined });
		expect(res.status).toBe(500);
	});

	it('401s on a bad secret', async () => {
		const res = await handleReminderCron(cronReq('wrong'), { secret: 'right' });
		expect(res.status).toBe(401);
	});

	it('no-ops cleanly when no provider is configured', async () => {
		const store = new FakeStore();
		const res = await handleReminderCron(cronReq('s'), {
			secret: 's',
			sender: null,
			store,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ skipped: 'no_provider' });
		expect(store.marked).toHaveLength(0);
	});

	it('runs the pass with a valid secret + provider', async () => {
		const store = new FakeStore([due('u1', 'a@b.co', 't1')], {
			u1: settingsRow('u1'),
		});
		const { sender } = okSender();
		const res = await handleReminderCron(cronReq('s'), {
			secret: 's',
			sender,
			store,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, sent: 2 });
	});
});

// --- state (sync) endpoint ----------------------------------------------

describe('handleReminderState', () => {
	const stateReq = (body: unknown) =>
		new Request('https://x/api/reminders/state', {
			method: 'POST',
			headers: {
				authorization: 'Bearer t',
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		});
	const entOk = async () =>
		({
			ok: true,
			userId: 'owner-1',
			tier: 'premium',
			status: 'active',
		}) as const;
	const entDenied = async () =>
		({
			ok: false,
			status: 403,
			code: 'subscription_required',
			message: '',
		}) as const;

	it('rejects a non-POST', async () => {
		const res = await handleReminderState(
			new Request('https://x', { method: 'GET' }),
		);
		expect(res.status).toBe(405);
	});

	it('propagates the entitlement gate (Hosted-only)', async () => {
		const res = await handleReminderState(
			stateReq({ settings: { enabled: true } }),
			{
				getEntitlementFn: entDenied,
				store: new FakeStore(),
			},
		);
		expect(res.status).toBe(403);
	});

	it('scopes every write to the authenticated user, never the body', async () => {
		const store = new FakeStore();
		const res = await handleReminderState(
			stateReq({
				// a hostile body trying to write someone else's rows:
				settings: { enabled: true, memberNudge: true, leadDigest: false },
				states: [
					{
						owner_user_id: 'victim',
						memberEmail: 'a@b.co',
						displayName: 'A',
						periodKey: '2026-03-02',
						complete: false,
						onLeave: false,
					},
				],
			}),
			{ getEntitlementFn: entOk, store },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, states: 1 });
		expect(store.settingsWrites[0].userId).toBe('owner-1');
		expect(store.stateWrites[0].userId).toBe('owner-1');
		// the body's owner_user_id is ignored — parsing only trusts known fields
		expect(store.stateWrites[0].states[0]).not.toHaveProperty('owner_user_id');
		expect(store.stateWrites[0].states[0].memberEmail).toBe('a@b.co');
	});

	it('400s on a body with no settings', async () => {
		const res = await handleReminderState(stateReq({ states: [] }), {
			getEntitlementFn: entOk,
			store: new FakeStore(),
		});
		expect(res.status).toBe(400);
	});
});
