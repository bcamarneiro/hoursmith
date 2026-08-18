import { buildLeadDigestEmail, buildMemberNudgeEmail } from './emails.js';
import type { EmailSender, ReminderPlan } from './types.js';

/**
 * Turn a reminder plan into actual sends (ADA-546). Provider-agnostic: the cron
 * injects a real {@link EmailSender}; tests inject a fake. Idempotent by
 * delivery token — a member already nudged for this period is skipped, so a
 * re-run (retry, overlapping cron) never double-sends.
 */

export interface DeliveryResult {
	sent: number;
	failed: number;
	skipped: number;
	failures: Array<{ to: string; error: string }>;
	/** Tokens sent this run — the caller persists these to the state store so a
	 *  member isn't nudged twice for the same period. */
	deliveredTokens: string[];
}

export async function deliverReminders(
	plan: ReminderPlan,
	sender: EmailSender,
	options: { alreadySent?: ReadonlySet<string> } = {},
): Promise<DeliveryResult> {
	const alreadySent = options.alreadySent ?? new Set<string>();
	const result: DeliveryResult = {
		sent: 0,
		failed: 0,
		skipped: 0,
		failures: [],
		deliveredTokens: [],
	};

	for (const nudge of plan.memberNudges) {
		if (nudge.deliveryToken && alreadySent.has(nudge.deliveryToken)) {
			result.skipped += 1;
			continue;
		}
		const outcome = await sender.send(buildMemberNudgeEmail(nudge));
		if (outcome.ok) {
			result.sent += 1;
			if (nudge.deliveryToken) result.deliveredTokens.push(nudge.deliveryToken);
		} else {
			result.failed += 1;
			result.failures.push({ to: nudge.to, error: outcome.error ?? 'unknown' });
		}
	}

	if (plan.leadDigest) {
		const outcome = await sender.send(buildLeadDigestEmail(plan.leadDigest));
		if (outcome.ok) {
			result.sent += 1;
		} else {
			result.failed += 1;
			result.failures.push({
				to: plan.leadDigest.to,
				error: outcome.error ?? 'unknown',
			});
		}
	}

	return result;
}
