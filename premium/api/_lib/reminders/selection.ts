import type {
	MemberCompleteness,
	PeriodInfo,
	ReminderPlan,
	ReminderSettings,
} from './types.js';

/**
 * Decide who gets nudged this run (ADA-546). Pure — the cron applies it to the
 * period's completeness state, then hands the plan to the delivery orchestrator.
 *
 * Rules:
 *  - Nothing when reminders are disabled (opt-in).
 *  - A member is a candidate only when incomplete AND not on leave — never nudge
 *    someone on PTO/holiday (ADA-393).
 *  - Member nudges and the lead digest are independently toggleable.
 *  - The lead digest is planned only when there's a recipient and ≥1 behind
 *    member — no "everyone's on track" spam.
 */
export function planReminders(
	members: MemberCompleteness[],
	settings: ReminderSettings,
	period: PeriodInfo,
): ReminderPlan {
	if (!settings.enabled) {
		return { memberNudges: [], leadDigest: null };
	}

	const behind = members.filter(
		(member) => !member.complete && !member.onLeave,
	);

	const memberNudges = settings.memberNudge
		? behind.map((member) => ({
				to: member.email,
				displayName: member.displayName,
				deliveryToken: member.deliveryToken,
				period,
			}))
		: [];

	const leadDigest =
		settings.leadDigest && settings.leadEmail && behind.length > 0
			? {
					to: settings.leadEmail,
					teamName: settings.teamName,
					behind: behind.map((member) => ({
						displayName: member.displayName,
						email: member.email,
					})),
					period,
				}
			: null;

	return { memberNudges, leadDigest };
}
