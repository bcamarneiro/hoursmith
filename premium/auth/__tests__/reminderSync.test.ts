import { describe, expect, it, vi } from 'vitest';
import {
	buildReminderStatePayload,
	postReminderState,
	type ReminderLocalSettings,
	type ReminderMemberInput,
} from '../reminderSync.js';

const settings: ReminderLocalSettings = {
	enabled: true,
	memberNudge: true,
	leadDigest: true,
	leadEmail: 'lead@team.co',
	teamName: 'Team',
};

const members: ReminderMemberInput[] = [
	{ email: 'a@b.co', displayName: 'A', complete: false, onLeave: false },
	{ email: 'c@b.co', displayName: 'C', complete: true, onLeave: false },
	{ email: '', displayName: 'ghost', complete: false, onLeave: false },
];

describe('buildReminderStatePayload', () => {
	it('maps members to the minimal per-period shape (no hours, no issue keys)', () => {
		const payload = buildReminderStatePayload(settings, members, '2026-03-02');
		expect(payload.settings).toBe(settings);
		expect(payload.states).toHaveLength(2); // empty-email member dropped
		expect(payload.states[0]).toEqual({
			memberEmail: 'a@b.co',
			displayName: 'A',
			periodKey: '2026-03-02',
			complete: false,
			onLeave: false,
		});
		// only the whitelisted keys ever leave the client
		expect(Object.keys(payload.states[0]).sort()).toEqual([
			'complete',
			'displayName',
			'memberEmail',
			'onLeave',
			'periodKey',
		]);
	});
});

describe('postReminderState', () => {
	it('sends a Bearer token and returns ok on 200', async () => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
		const result = await postReminderState(
			'tok',
			buildReminderStatePayload(settings, members, 'p'),
			fetchImpl as unknown as typeof fetch,
		);
		expect(result.ok).toBe(true);
		const [, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect((init.headers as Record<string, string>).authorization).toBe(
			'Bearer tok',
		);
	});

	it('surfaces the server error code on a non-2xx', async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: 'subscription_required' }), {
					status: 403,
				}),
		);
		const result = await postReminderState(
			'tok',
			buildReminderStatePayload(settings, [], 'p'),
			fetchImpl as unknown as typeof fetch,
		);
		expect(result).toMatchObject({
			ok: false,
			status: 403,
			error: 'subscription_required',
		});
	});

	it('never throws on a network failure', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('offline');
		});
		const result = await postReminderState(
			'tok',
			buildReminderStatePayload(settings, [], 'p'),
			fetchImpl as unknown as typeof fetch,
		);
		expect(result).toMatchObject({ ok: false, status: 0, error: 'offline' });
	});
});
