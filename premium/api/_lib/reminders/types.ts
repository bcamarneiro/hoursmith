/**
 * Reminder-email substrate types (ADA-546, split from ADA-389).
 *
 * The flagship Hosted paid hook: the server chases incomplete timesheets so the
 * lead never has to. This module holds the provider-agnostic shapes shared by
 * the selection logic, the email templates, and the delivery orchestrator. The
 * later channels (webhooks → Web Push → Slack → Teams, ADA-389) reuse the same
 * substrate — hence a channel-neutral `EmailSender` seam and a "plan" the cron
 * turns into sends.
 *
 * Privacy invariant: the completeness-state store holds only a per-member/period
 * *complete* flag + a delivery token. Never worklog detail. These types honour
 * that — a member is `complete` or not; the reason never leaves the browser.
 */

/** Minimal per-member state for one reporting period (from the state store). */
export interface MemberCompleteness {
	email: string;
	displayName: string;
	/** Met the period's expectation on time. Incomplete → nudge candidate. */
	complete: boolean;
	/** On PTO/holiday for the whole period — never nudge (consumes ADA-393). */
	onLeave?: boolean;
	/** Opaque per-member/period token: idempotency + one-click unsubscribe. */
	deliveryToken?: string;
}

/** Per-team reminder configuration (opt-in). */
export interface ReminderSettings {
	/** Master switch. When false, nothing is ever sent. */
	enabled: boolean;
	/** Send each behind member a personal nudge. */
	memberNudge: boolean;
	/** Send the lead a "who's behind" digest. */
	leadDigest: boolean;
	/** Where the lead digest goes. Required for the digest to be planned. */
	leadEmail?: string;
	/** Team name for copy (optional). */
	teamName?: string;
}

/** Human-facing period labels for email copy. */
export interface PeriodInfo {
	/** e.g. "the week of 3 Mar". */
	label: string;
	/** e.g. "Friday 18:00". Optional. */
	dueLabel?: string;
}

export interface MemberNudge {
	to: string;
	displayName: string;
	deliveryToken?: string;
	period: PeriodInfo;
}

export interface LeadDigest {
	to: string;
	teamName?: string;
	behind: Array<{ displayName: string; email: string }>;
	period: PeriodInfo;
}

/** What the cron sends this run. Empty arrays/null mean "nothing to send". */
export interface ReminderPlan {
	memberNudges: MemberNudge[];
	leadDigest: LeadDigest | null;
}

export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
	html: string;
}

/** Channel seam — a real provider (Resend/Postmark/SES) implements this. */
export interface EmailSender {
	send(
		message: EmailMessage,
	): Promise<{ ok: boolean; id?: string; error?: string }>;
}
