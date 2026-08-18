/**
 * Persistent-failure alerting engine (ADA-691).
 *
 * Decides whether a batch of persistent (dead-lettered) queue failures crosses
 * the configured alert thresholds and dispatches notifications to the
 * configured channels (Slack incoming webhook + email relay webhook).
 *
 * A "persistent failure" is a queue job that exhausted its retry attempts —
 * BullMQ leaves those in the failed set, which is our dead-letter queue. The
 * DLQ monitor gathers failed jobs on an interval and feeds them to
 * `evaluateAndDispatch`, which:
 *   1. keeps only failures inside the configured window that match the
 *      configured error patterns,
 *   2. alerts only once the failure count reaches `minFailures`,
 *   3. suppresses re-alerts for the same queue until `cooldownMs` elapses,
 *   4. posts to every configured channel. Channel failures never throw — a
 *      broken Slack webhook must not take down the DLQ monitor.
 *
 * This module is dependency-free and edge-compatible: `fetch` is injected so
 * tests exercise dispatch without network.
 */

import type { AlertSettings } from './alertConfig.js';

/** One persistent failure (a job that exhausted its attempts). */
export interface AlertEvent {
	/** BullMQ queue name the failed job belonged to. */
	queue: string;
	/** BullMQ job id. */
	jobId: string;
	/** Human-readable job name, e.g. `raw-commits`. */
	jobName?: string;
	/** Failure message (last attempt's error), matched against patterns. */
	errorMessage: string;
	/** Epoch ms when the job permanently failed. */
	failedAt: number;
}

/** Result of evaluating a failure batch against the alert thresholds. */
export interface AlertDecision {
	shouldAlert: boolean;
	/** Number of failures in the window that matched the configured patterns. */
	count: number;
	/** The failures that counted toward the threshold (window + patterns). */
	windowFailures: AlertEvent[];
	/** Human-readable explanation; null when the batch did not reach the threshold. */
	reason: string | null;
}

/** Cooldown bookkeeping: last alert time per queue, in epoch ms. */
export interface AlertState {
	lastAlertAtByQueue: Record<string, number>;
}

/** Injectable fetch so dispatch stays testable without network. */
export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

/** Per-channel dispatch outcome. */
export interface ChannelResults {
	slack: boolean;
	email: boolean;
}

/** Outcome of a full evaluate + dispatch pass. */
export interface AlertOutcome extends ChannelResults {
	alerted: boolean;
	decision: AlertDecision;
}

/** Text of a Slack notification for a set of dead-lettered failures. */
export function formatSlackText(
	queue: string,
	failures: readonly AlertEvent[],
	settings: AlertSettings,
): string {
	const first = failures[0];
	const sample = first
		? `\n> e.g. \`${first.jobName ?? first.jobId}\` — ${truncate(first.errorMessage, 300)}`
		: '';
	return [
		`⚠️ *Persistent failure alert* — \`${queue}\``,
		`${failures.length} dead-lettered job(s) in the last ${formatWindow(settings.windowMs)} (threshold: ${settings.minFailures}).`,
		sample,
	].join('\n');
}

/** Subject line of the email notification. */
export function formatEmailSubject(queue: string, count: number): string {
	return `[Hoursmith] Persistent failure alert: ${queue} (${count} DLQ events)`;
}

/** Plain-text body of the email notification. */
export function formatEmailBody(
	queue: string,
	failures: readonly AlertEvent[],
	settings: AlertSettings,
): string {
	const lines = [
		`Queue: ${queue}`,
		`Dead-lettered jobs: ${failures.length} in the last ${formatWindow(settings.windowMs)} (threshold: ${settings.minFailures}).`,
		'',
	];
	for (const failure of failures.slice(0, 10)) {
		lines.push(
			`- ${failure.jobName ?? failure.jobId}: ${truncate(failure.errorMessage, 300)} (failed at ${new Date(failure.failedAt).toISOString()})`,
		);
	}
	if (failures.length > 10) {
		lines.push(`- … and ${failures.length - 10} more.`);
	}
	return lines.join('\n');
}

/**
 * True when a failure message matches at least one configured pattern.
 * An empty pattern list matches every failure (alert on all DLQ events).
 */
export function matchesErrorPattern(
	event: AlertEvent,
	patterns: readonly string[],
): boolean {
	if (patterns.length === 0) return true;
	return patterns.some((pattern) =>
		new RegExp(pattern, 'i').test(event.errorMessage),
	);
}

/**
 * Evaluate a batch of failed jobs against the configured thresholds:
 * window filter + error-pattern filter + minimum failure count.
 */
export function evaluateFailures(
	events: readonly AlertEvent[],
	settings: AlertSettings,
	now: number = Date.now(),
): AlertDecision {
	const cutoff = now - settings.windowMs;
	const windowFailures = events.filter(
		(event) =>
			event.failedAt >= cutoff &&
			event.failedAt <= now &&
			matchesErrorPattern(event, settings.errorPatterns),
	);
	const count = windowFailures.length;
	if (count >= settings.minFailures) {
		return {
			shouldAlert: true,
			count,
			windowFailures,
			reason: `${count} dead-lettered jobs in the last ${formatWindow(settings.windowMs)} (threshold: ${settings.minFailures}).`,
		};
	}
	return {
		shouldAlert: false,
		count,
		windowFailures,
		reason: null,
	};
}

/**
 * True when an alert may fire for `queue` — i.e. the cooldown since the last
 * alert for that queue has elapsed (or no alert has been sent yet).
 */
export function isCooldownElapsed(
	state: AlertState,
	queue: string,
	settings: AlertSettings,
	now: number,
): boolean {
	const last = state.lastAlertAtByQueue[queue];
	if (last === undefined) return true;
	return now - last >= settings.cooldownMs;
}

/** Record that an alert was sent for `queue` at `now`. */
export function markAlertSent(
	state: AlertState,
	queue: string,
	now: number,
): void {
	state.lastAlertAtByQueue[queue] = now;
}

/**
 * Dispatch a formatted alert to every configured channel. Returns per-channel
 * success flags and never throws — a failed webhook must not crash the caller.
 */
export async function sendAlertNotifications(
	settings: AlertSettings,
	payload: { queue: string; failures: readonly AlertEvent[] },
	fetchImpl: FetchLike = fetch,
): Promise<ChannelResults> {
	const results: ChannelResults = { slack: false, email: false };
	if (settings.slackWebhookUrl) {
		results.slack = await postJson(
			settings.slackWebhookUrl,
			{ text: formatSlackText(payload.queue, payload.failures, settings) },
			fetchImpl,
			settings.webhookTimeoutMs,
		);
	}
	if (settings.emailWebhookUrl && settings.emailRecipients.length > 0) {
		results.email = await postJson(
			settings.emailWebhookUrl,
			{
				to: settings.emailRecipients,
				subject: formatEmailSubject(payload.queue, payload.failures.length),
				text: formatEmailBody(payload.queue, payload.failures, settings),
			},
			fetchImpl,
			settings.webhookTimeoutMs,
		);
	}
	return results;
}

/**
 * One-call surface for the DLQ monitor: evaluate the failure batch for a
 * queue, respect the cooldown, dispatch to the configured channels, and record
 * the alert time. Returns the outcome for logging; a suppressed, below-threshold,
 * or channel-less pass returns `alerted: false` and does not advance the cooldown.
 */
export async function evaluateAndDispatch(
	events: readonly AlertEvent[],
	queue: string,
	state: AlertState,
	settings: AlertSettings,
	deps: { now?: number; fetchImpl?: FetchLike } = {},
): Promise<AlertOutcome> {
	const now = deps.now ?? Date.now();
	const queueEvents = events.filter((event) => event.queue === queue);
	const decision = evaluateFailures(queueEvents, settings, now);
	const noop: AlertOutcome = {
		alerted: false,
		decision,
		slack: false,
		email: false,
	};
	if (!decision.shouldAlert) return noop;
	const hasChannels =
		settings.slackWebhookUrl !== '' ||
		(settings.emailWebhookUrl !== '' && settings.emailRecipients.length > 0);
	if (!hasChannels) {
		return {
			...noop,
			decision: {
				...decision,
				reason:
					'Threshold reached but no notification channels are configured.',
			},
		};
	}
	if (!isCooldownElapsed(state, queue, settings, now)) {
		return {
			...noop,
			decision: {
				...decision,
				reason: `Suppressed by cooldown (${settings.cooldownMs}ms).`,
			},
		};
	}
	const results = await sendAlertNotifications(
		settings,
		{ queue, failures: decision.windowFailures },
		deps.fetchImpl ?? fetch,
	);
	if (results.slack || results.email) {
		markAlertSent(state, queue, now);
	}
	return {
		alerted: true,
		decision: { ...decision, reason: decision.reason ?? null },
		...results,
	};
}

async function postJson(
	url: string,
	body: Record<string, unknown>,
	fetchImpl: FetchLike,
	timeoutMs: number,
): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await fetchImpl(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatWindow(ms: number): string {
	if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
	if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 1_000)}s`;
}
