import { describe, expect, it, vi } from 'vitest';
import { deliverReminders } from '../deliver.js';
import { buildLeadDigestEmail, buildMemberNudgeEmail } from '../emails.js';
import { createResendSender, resendSenderFromEnv } from '../resendSender.js';
import { planReminders } from '../selection.js';
import type {
	EmailMessage,
	EmailSender,
	MemberCompleteness,
	ReminderSettings,
} from '../types.js';

const period = { label: 'the week of 3 Mar', dueLabel: 'Friday 18:00' };

const members: MemberCompleteness[] = [
	{
		email: 'a@x.com',
		displayName: 'Ana',
		complete: false,
		deliveryToken: 't-a',
	},
	{ email: 'b@x.com', displayName: 'Bo', complete: true, deliveryToken: 't-b' },
	{
		email: 'c@x.com',
		displayName: 'Cy',
		complete: false,
		onLeave: true,
		deliveryToken: 't-c',
	},
];

const settings = (over: Partial<ReminderSettings> = {}): ReminderSettings => ({
	enabled: true,
	memberNudge: true,
	leadDigest: true,
	leadEmail: 'lead@x.com',
	teamName: 'Team',
	...over,
});

describe('planReminders (ADA-546)', () => {
	it('sends nothing when reminders are disabled', () => {
		const plan = planReminders(members, settings({ enabled: false }), period);
		expect(plan.memberNudges).toEqual([]);
		expect(plan.leadDigest).toBeNull();
	});

	it('nudges only incomplete members who are not on leave', () => {
		const plan = planReminders(members, settings(), period);
		expect(plan.memberNudges.map((n) => n.to)).toEqual(['a@x.com']);
		// Complete (Bo) and on-leave (Cy) are never nudged.
	});

	it('plans the lead digest only with a recipient and ≥1 behind member', () => {
		expect(
			planReminders(members, settings(), period).leadDigest?.behind,
		).toHaveLength(1);
		expect(
			planReminders(members, settings({ leadEmail: undefined }), period)
				.leadDigest,
		).toBeNull();
		const allComplete = members.map((m) => ({ ...m, complete: true }));
		expect(
			planReminders(allComplete, settings(), period).leadDigest,
		).toBeNull();
	});

	it('toggles member nudges and lead digest independently', () => {
		const noMember = planReminders(
			members,
			settings({ memberNudge: false }),
			period,
		);
		expect(noMember.memberNudges).toEqual([]);
		expect(noMember.leadDigest).not.toBeNull();
	});
});

describe('reminder email templates (ADA-546)', () => {
	it('builds a relief-framed member nudge', () => {
		const email = buildMemberNudgeEmail({
			to: 'a@x.com',
			displayName: 'Ana',
			period,
		});
		expect(email.subject).toContain('the week of 3 Mar');
		expect(email.text).toContain('Ana');
		expect(email.text).toContain('due Friday 18:00');
		expect(email.text).toContain('not a measure of your productivity');
	});

	it('builds a lead digest that lists behind members and escapes html', () => {
		const email = buildLeadDigestEmail({
			to: 'lead@x.com',
			teamName: 'Acme',
			period,
			behind: [{ displayName: 'A & B <x>', email: 'a@x.com' }],
		});
		expect(email.subject).toContain('Acme: 1 person');
		expect(email.html).toContain('A &amp; B &lt;x&gt;');
		expect(email.html).not.toContain('A & B <x>');
	});
});

function fakeSender(fail = false): EmailSender & { sent: EmailMessage[] } {
	const sent: EmailMessage[] = [];
	return {
		sent,
		async send(message) {
			sent.push(message);
			return fail ? { ok: false, error: 'boom' } : { ok: true, id: 'id1' };
		},
	};
}

describe('deliverReminders (ADA-546)', () => {
	it('sends member nudges + lead digest and reports delivered tokens', async () => {
		const sender = fakeSender();
		const plan = planReminders(members, settings(), period);
		const result = await deliverReminders(plan, sender);
		expect(result.sent).toBe(2); // 1 nudge + 1 digest
		expect(result.deliveredTokens).toEqual(['t-a']);
		expect(sender.sent).toHaveLength(2);
	});

	it('skips members already sent for this period (idempotent)', async () => {
		const sender = fakeSender();
		const plan = planReminders(
			members,
			settings({ leadDigest: false }),
			period,
		);
		const result = await deliverReminders(plan, sender, {
			alreadySent: new Set(['t-a']),
		});
		expect(result.skipped).toBe(1);
		expect(result.sent).toBe(0);
		expect(sender.sent).toHaveLength(0);
	});

	it('records failures without throwing', async () => {
		const sender = fakeSender(true);
		const plan = planReminders(
			members,
			settings({ leadDigest: false }),
			period,
		);
		const result = await deliverReminders(plan, sender);
		expect(result.failed).toBe(1);
		expect(result.failures[0]).toEqual({ to: 'a@x.com', error: 'boom' });
	});
});

describe('resendSender (ADA-546)', () => {
	it('posts to Resend and returns the id on success', async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }),
		) as unknown as typeof fetch;
		const sender = createResendSender({
			apiKey: 'k',
			from: 'r@x.com',
			fetchImpl,
		});
		const out = await sender.send({
			to: 'a@x.com',
			subject: 's',
			text: 't',
			html: '<p>t</p>',
		});
		expect(out).toEqual({ ok: true, id: 'msg_1' });
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://api.resend.com/emails',
			expect.objectContaining({ method: 'POST' }),
		);
	});

	it('maps a non-2xx response to an error result', async () => {
		const fetchImpl = vi.fn(
			async () => new Response('nope', { status: 422 }),
		) as unknown as typeof fetch;
		const sender = createResendSender({
			apiKey: 'k',
			from: 'r@x.com',
			fetchImpl,
		});
		const out = await sender.send({
			to: 'a@x.com',
			subject: 's',
			text: 't',
			html: 'h',
		});
		expect(out).toEqual({ ok: false, error: 'resend_http_422' });
	});

	it('resendSenderFromEnv is null until the provider is configured', () => {
		expect(resendSenderFromEnv({})).toBeNull();
		expect(
			resendSenderFromEnv({ RESEND_API_KEY: 'k', REMINDER_FROM: 'r@x.com' }),
		).not.toBeNull();
	});
});
