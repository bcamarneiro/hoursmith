/**
 * Tests for the persistent-failure alerting engine (ADA-691).
 *
 * Threshold evaluation, error-pattern matching, cooldown suppression, and
 * channel dispatch are exercised with an injected fetch so no network is
 * touched.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	evaluateAndDispatch,
	evaluateFailures,
	formatEmailBody,
	formatEmailSubject,
	formatSlackText,
	isCooldownElapsed,
	markAlertSent,
	matchesErrorPattern,
	sendAlertNotifications,
	type AlertEvent,
	type AlertState,
} from '../alerting.js';
import { ALERT_SETTINGS_DEFAULTS } from '../alertConfig.js';

const now = 1_800_000_000_000;

function event(overrides: Partial<AlertEvent>): AlertEvent {
	return {
		queue: 'raw-commits',
		jobId: 'job-1',
		jobName: 'raw-commits',
		errorMessage: 'ECONNRESET',
		failedAt: now - 1_000,
		...overrides,
	};
}

function settings(overrides: Partial<typeof ALERT_SETTINGS_DEFAULTS> = {}) {
	return { ...ALERT_SETTINGS_DEFAULTS, ...overrides };
}

function okResponse(): Response {
	return { ok: true } as Response;
}

describe('matchesErrorPattern', () => {
	it('matches every failure when no patterns are configured', () => {
		expect(matchesErrorPattern(event({}), [])).toBe(true);
	});

	it('matches case-insensitively against the error message', () => {
		expect(
			matchesErrorPattern(event({ errorMessage: 'connect ECONNRESET' }), [
				'econnreset',
			]),
		).toBe(true);
	});

	it('matches on regex special characters', () => {
		expect(
			matchesErrorPattern(
				event({ errorMessage: 'gateway timeout after 502 Bad Gateway' }),
				['timeout.*502'],
			),
		).toBe(true);
	});

	it('returns false when no pattern matches', () => {
		expect(
			matchesErrorPattern(event({ errorMessage: 'ECONNRESET' }), ['timeout']),
		).toBe(false);
	});
});

describe('evaluateFailures', () => {
	it('does not alert below the failure threshold', () => {
		const decision = evaluateFailures(
			[event({}), event({})],
			settings({ minFailures: 3 }),
			now,
		);
		expect(decision.shouldAlert).toBe(false);
		expect(decision.count).toBe(2);
	});

	it('alerts at the failure threshold', () => {
		const decision = evaluateFailures(
			[event({}), event({}), event({})],
			settings({ minFailures: 3 }),
			now,
		);
		expect(decision.shouldAlert).toBe(true);
		expect(decision.count).toBe(3);
	});

	it('ignores failures older than the window', () => {
		const decision = evaluateFailures(
			[event({ failedAt: now - 3_700_000 })],
			settings({ windowMs: 3_600_000, minFailures: 1 }),
			now,
		);
		expect(decision.shouldAlert).toBe(false);
		expect(decision.count).toBe(0);
	});

	it('only counts failures that match the configured patterns', () => {
		const decision = evaluateFailures(
			[
				event({ errorMessage: 'ECONNRESET' }),
				event({ errorMessage: 'ETIMEDOUT' }),
			],
			settings({ minFailures: 2, errorPatterns: ['ECONNRESET'] }),
			now,
		);
		expect(decision.shouldAlert).toBe(false);
		expect(decision.count).toBe(1);
	});
});

describe('cooldown', () => {
	it('allows the first alert for a queue', () => {
		expect(
			isCooldownElapsed(
				{ lastAlertAtByQueue: {} },
				'raw-commits',
				settings(),
				now,
			),
		).toBe(true);
	});

	it('suppresses alerts inside the cooldown window', () => {
		const state: AlertState = {
			lastAlertAtByQueue: { 'raw-commits': now - 60_000 },
		};
		expect(
			isCooldownElapsed(
				state,
				'raw-commits',
				settings({ cooldownMs: 900_000 }),
				now,
			),
		).toBe(false);
	});

	it('allows alerts after the cooldown window elapses', () => {
		const state: AlertState = {
			lastAlertAtByQueue: { 'raw-commits': now - 900_000 },
		};
		expect(
			isCooldownElapsed(
				state,
				'raw-commits',
				settings({ cooldownMs: 900_000 }),
				now,
			),
		).toBe(true);
	});

	it('records the alert time for a queue', () => {
		const state: AlertState = { lastAlertAtByQueue: {} };
		markAlertSent(state, 'raw-commits', now);
		expect(state.lastAlertAtByQueue['raw-commits']).toBe(now);
	});
});

describe('sendAlertNotifications', () => {
	it('posts the formatted alert to the Slack webhook', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());
		const results = await sendAlertNotifications(
			settings({ slackWebhookUrl: 'https://hooks.slack.com/x' }),
			{ queue: 'raw-commits', failures: [event({})] },
			fetchImpl,
		);
		expect(results).toEqual({ slack: true, email: false });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://hooks.slack.com/x');
		expect(JSON.parse(String(init.body))).toMatchObject({
			text: expect.stringContaining('raw-commits'),
		});
	});

	it('posts the formatted alert to the email webhook', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());
		const results = await sendAlertNotifications(
			settings({
				emailRecipients: ['ops@hoursmith.dev'],
				emailWebhookUrl: 'https://mail.hoursmith.dev/send',
			}),
			{ queue: 'raw-commits', failures: [event({})] },
			fetchImpl,
		);
		expect(results).toEqual({ slack: false, email: true });
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toMatchObject({
			to: ['ops@hoursmith.dev'],
			subject: expect.stringContaining('raw-commits'),
			text: expect.stringContaining('ECONNRESET'),
		});
	});

	it('reports failure when a webhook responds non-OK', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 500 } as Response);
		const results = await sendAlertNotifications(
			settings({
				slackWebhookUrl: 'https://hooks.slack.com/x',
				emailRecipients: ['ops@hoursmith.dev'],
				emailWebhookUrl: 'https://mail.hoursmith.dev/send',
			}),
			{ queue: 'raw-commits', failures: [event({})] },
			fetchImpl,
		);
		expect(results).toEqual({ slack: false, email: false });
	});

	it('never throws when the webhook fetch rejects', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
		const results = await sendAlertNotifications(
			settings({
				slackWebhookUrl: 'https://hooks.slack.com/x',
				emailRecipients: ['ops@hoursmith.dev'],
				emailWebhookUrl: 'https://mail.hoursmith.dev/send',
			}),
			{ queue: 'raw-commits', failures: [event({})] },
			fetchImpl,
		);
		expect(results).toEqual({ slack: false, email: false });
	});

	it('skips channels that are not configured', async () => {
		const fetchImpl = vi.fn();
		const results = await sendAlertNotifications(
			settings(),
			{ queue: 'raw-commits', failures: [event({})] },
			fetchImpl,
		);
		expect(results).toEqual({ slack: false, email: false });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('evaluateAndDispatch', () => {
	it('alerts and dispatches when the threshold is reached', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());
		const state: AlertState = { lastAlertAtByQueue: {} };
		const outcome = await evaluateAndDispatch(
			[event({}), event({}), event({})],
			'raw-commits',
			state,
			settings({
				minFailures: 3,
				slackWebhookUrl: 'https://hooks.slack.com/x',
				emailRecipients: ['ops@hoursmith.dev'],
				emailWebhookUrl: 'https://mail.hoursmith.dev/send',
			}),
			{ now, fetchImpl },
		);
		expect(outcome.alerted).toBe(true);
		expect(outcome.slack).toBe(true);
		expect(outcome.email).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(state.lastAlertAtByQueue['raw-commits']).toBe(now);
	});

	it('does not dispatch below the threshold and does not advance cooldown', async () => {
		const fetchImpl = vi.fn();
		const state: AlertState = { lastAlertAtByQueue: {} };
		const outcome = await evaluateAndDispatch(
			[event({}), event({})],
			'raw-commits',
			state,
			settings({
				minFailures: 3,
				slackWebhookUrl: 'https://hooks.slack.com/x',
			}),
			{ now, fetchImpl },
		);
		expect(outcome.alerted).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(state.lastAlertAtByQueue).toEqual({});
	});

	it('suppresses a second alert inside the cooldown window', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());
		const state: AlertState = {
			lastAlertAtByQueue: { 'raw-commits': now - 60_000 },
		};
		const outcome = await evaluateAndDispatch(
			[event({}), event({}), event({})],
			'raw-commits',
			state,
			settings({
				minFailures: 3,
				cooldownMs: 900_000,
				slackWebhookUrl: 'https://hooks.slack.com/x',
			}),
			{ now, fetchImpl },
		);
		expect(outcome.alerted).toBe(false);
		expect(outcome.decision.reason).toContain('cooldown');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('does not fire when no channels are configured', async () => {
		const fetchImpl = vi.fn();
		const state: AlertState = { lastAlertAtByQueue: {} };
		const outcome = await evaluateAndDispatch(
			[event({}), event({}), event({})],
			'raw-commits',
			state,
			settings({ minFailures: 3 }),
			{ now, fetchImpl },
		);
		expect(outcome.alerted).toBe(false);
		expect(outcome.decision.reason).toContain('no notification channels');
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(state.lastAlertAtByQueue).toEqual({});
	});

	it('only counts failures for the requested queue', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());
		const state: AlertState = { lastAlertAtByQueue: {} };
		const outcome = await evaluateAndDispatch(
			[
				event({ jobId: 'a' }),
				event({ jobId: 'b' }),
				event({ jobId: 'c', queue: 'other-queue' }),
			],
			'raw-commits',
			state,
			settings({
				minFailures: 3,
				slackWebhookUrl: 'https://hooks.slack.com/x',
			}),
			{ now, fetchImpl },
		);
		expect(outcome.alerted).toBe(false);
		expect(outcome.decision.count).toBe(2);
	});
});

describe('formatters', () => {
	it('includes queue, count, and a sample error in the Slack text', () => {
		const text = formatSlackText(
			'raw-commits',
			[event({ errorMessage: 'ECONNRESET' })],
			settings(),
		);
		expect(text).toContain('raw-commits');
		expect(text).toContain('1 dead-lettered');
		expect(text).toContain('ECONNRESET');
	});

	it('builds a queue-scoped email subject', () => {
		expect(formatEmailSubject('raw-commits', 4)).toBe(
			'[Hoursmith] Persistent failure alert: raw-commits (4 DLQ events)',
		);
	});

	it('caps the email body sample at ten failures', () => {
		const failures = Array.from({ length: 12 }, (_, i) =>
			event({ jobId: `job-${i}` }),
		);
		const body = formatEmailBody('raw-commits', failures, settings());
		expect(body).toContain('… and 2 more.');
	});
});
