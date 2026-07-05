/**
 * GET /api/cron/reminders  (Vercel Cron, Hosted only)
 *
 * Fires the reminder pass when tabs are closed — the thing a lead pays for.
 * Guarded by `CRON_SECRET` (Vercel Cron sends it as a Bearer token). Thin
 * wrapper over the tested `runReminderCron`; no-ops cleanly when the email
 * provider isn't configured yet, so enabling the cron before wiring Resend is
 * harmless.
 *
 * Linear: ADA-552 (wires the ADA-546 substrate).
 */

import { runReminderCron } from '../_lib/reminders/cron.js';
import { resendSenderFromEnv } from '../_lib/reminders/resendSender.js';
import {
	defaultRemindersStore,
	type RemindersStore,
} from '../_lib/reminders/store.js';
import type { EmailSender } from '../_lib/reminders/types.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface ReminderCronDeps {
	store?: RemindersStore;
	sender?: EmailSender | null;
	secret?: string;
}

export default async function handler(request: Request): Promise<Response> {
	return handleReminderCron(request);
}

export async function handleReminderCron(
	request: Request,
	deps: ReminderCronDeps = {},
): Promise<Response> {
	if (request.method !== 'GET') {
		return json(405, { error: 'method_not_allowed' });
	}

	const secret = deps.secret ?? process.env.CRON_SECRET;
	if (!secret) {
		log({ status: 500, note: 'cron_secret_unset' });
		return json(500, { error: 'server_misconfigured' });
	}
	if (request.headers.get('authorization') !== `Bearer ${secret}`) {
		log({ status: 401, note: 'bad_cron_secret' });
		return json(401, { error: 'unauthorized' });
	}

	// No provider configured yet → clean no-op (cron can be enabled early).
	const sender =
		deps.sender !== undefined ? deps.sender : resendSenderFromEnv();
	if (!sender) {
		log({ status: 200, note: 'no_provider' });
		return json(200, { ok: true, skipped: 'no_provider' });
	}

	let store: RemindersStore;
	try {
		store = deps.store ?? defaultRemindersStore();
	} catch (err) {
		log({ status: 500, note: `misconfigured:${(err as Error).message}` });
		return json(500, { error: 'server_misconfigured' });
	}

	try {
		const summary = await runReminderCron(store, sender);
		log({
			status: 200,
			note: `owners:${summary.owners} sent:${summary.sent} failed:${summary.failed}`,
		});
		return json(200, { ok: true, ...summary });
	} catch (err) {
		log({ status: 500, note: `cron_failed:${(err as Error).message}` });
		return json(500, { error: 'cron_failed' });
	}
}

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function log(fields: { status: number; note?: string }): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-reminders-cron',
			status: fields.status,
			...(fields.note ? { note: fields.note } : {}),
		}),
	);
}
