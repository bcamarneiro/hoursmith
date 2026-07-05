/**
 * POST /api/reminders/state
 *
 * The lead's browser computes per-member completeness for the current period
 * (it already has the team data) and syncs the MINIMUM here: a complete flag +
 * delivery token per member, plus the team's reminder settings. The cron reads
 * this store — never Jira, never worklog detail — so the privacy promise holds.
 *
 * Security: Hosted-tier only, and every row is scoped to the authenticated
 * user (`owner_user_id` derived from the verified JWT, NEVER from the body).
 *
 * Logging: user_id + counts + outcome only. Never tokens, emails, or body.
 *
 * Linear: ADA-552 (wires the ADA-546 substrate).
 */

import { getEntitlement } from '../_lib/entitlement.js';
import {
	defaultRemindersStore,
	type ReminderStateInput,
	type RemindersStore,
} from '../_lib/reminders/store.js';
import type { ReminderSettings } from '../_lib/reminders/types.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface ReminderStateDeps {
	store?: RemindersStore;
	getEntitlementFn?: typeof getEntitlement;
}

export default async function handler(request: Request): Promise<Response> {
	return handleReminderState(request);
}

export async function handleReminderState(
	request: Request,
	deps: ReminderStateDeps = {},
): Promise<Response> {
	if (request.method !== 'POST') {
		return json(405, { error: 'method_not_allowed' });
	}

	const getEnt = deps.getEntitlementFn ?? getEntitlement;
	const entitlement = await getEnt(request);
	if (!entitlement.ok) {
		log({ userId: null, status: entitlement.status, note: entitlement.code });
		return json(entitlement.status, { error: entitlement.code });
	}
	const userId = entitlement.userId;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		log({ userId, status: 400, note: 'bad_json' });
		return json(400, { error: 'bad_json' });
	}

	const settings = parseSettings(body);
	const states = parseStates(body);
	if (!settings) {
		log({ userId, status: 400, note: 'bad_settings' });
		return json(400, { error: 'bad_settings' });
	}

	let store: RemindersStore;
	try {
		store = deps.store ?? defaultRemindersStore();
	} catch (err) {
		log({
			userId,
			status: 500,
			note: `misconfigured:${(err as Error).message}`,
		});
		return json(500, { error: 'server_misconfigured' });
	}

	try {
		await store.upsertSettings(userId, settings);
		await store.upsertStates(userId, states);
	} catch (err) {
		log({
			userId,
			status: 500,
			note: `write_failed:${(err as Error).message}`,
		});
		return json(500, { error: 'reminder_write_failed' });
	}

	log({ userId, status: 200, note: `states:${states.length}` });
	return json(200, { ok: true, states: states.length });
}

// --- parsing (defensive: the body is untrusted) ---

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: null;
}

function parseSettings(body: unknown): ReminderSettings | null {
	const root = asRecord(body);
	const raw = asRecord(root?.settings);
	if (!raw) return null;
	if (typeof raw.enabled !== 'boolean') return null;
	return {
		enabled: raw.enabled,
		memberNudge: raw.memberNudge !== false,
		leadDigest: raw.leadDigest !== false,
		leadEmail: typeof raw.leadEmail === 'string' ? raw.leadEmail : undefined,
		teamName: typeof raw.teamName === 'string' ? raw.teamName : undefined,
	};
}

function parseStates(body: unknown): ReminderStateInput[] {
	const root = asRecord(body);
	const list = Array.isArray(root?.states) ? root?.states : [];
	const states: ReminderStateInput[] = [];
	for (const item of list) {
		const row = asRecord(item);
		if (!row) continue;
		if (typeof row.memberEmail !== 'string' || !row.memberEmail) continue;
		if (typeof row.periodKey !== 'string' || !row.periodKey) continue;
		states.push({
			memberEmail: row.memberEmail,
			displayName: typeof row.displayName === 'string' ? row.displayName : '',
			periodKey: row.periodKey,
			complete: row.complete === true,
			onLeave: row.onLeave === true,
			deliveryToken:
				typeof row.deliveryToken === 'string' ? row.deliveryToken : undefined,
		});
	}
	return states;
}

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function log(fields: {
	userId: string | null;
	status: number;
	note?: string;
}): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-reminders-state',
			user_id: fields.userId,
			status: fields.status,
			...(fields.note ? { note: fields.note } : {}),
		}),
	);
}
