import type { EmailMessage, EmailSender } from './types.js';

/**
 * Resend adapter for the {@link EmailSender} seam (ADA-546).
 *
 * Resend is a sensible default (simple REST API, EU region, fits the local-first
 * / EU posture), but nothing above this file knows the provider — swapping to
 * Postmark/SES is another adapter with the same interface. Dependency-free
 * `fetch`, mirroring the other `_lib` clients; `fetchImpl` is injectable for
 * tests.
 *
 * Requires `RESEND_API_KEY` and a verified `REMINDER_FROM` sender (SPF/DKIM/
 * DMARC on the domain — owner ops, not code). {@link resendSenderFromEnv}
 * returns null when unset so the cron can no-op cleanly pre-launch.
 */

export interface ResendConfig {
	apiKey: string;
	/** Verified From address, e.g. "Hoursmith <reminders@hoursmith.io>". */
	from: string;
	fetchImpl?: typeof fetch;
}

export function createResendSender(config: ResendConfig): EmailSender {
	const doFetch = config.fetchImpl ?? fetch;
	return {
		async send(message: EmailMessage) {
			try {
				const res = await doFetch('https://api.resend.com/emails', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${config.apiKey}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						from: config.from,
						to: message.to,
						subject: message.subject,
						text: message.text,
						html: message.html,
					}),
				});
				if (!res.ok) {
					return { ok: false, error: `resend_http_${res.status}` };
				}
				const data = (await res.json().catch(() => ({}))) as { id?: string };
				return { ok: true, id: data.id };
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : 'resend_error',
				};
			}
		},
	};
}

/** Build a sender from env, or null when the provider isn't configured yet. */
export function resendSenderFromEnv(
	env: Record<string, string | undefined> = process.env,
): EmailSender | null {
	const apiKey = env.RESEND_API_KEY;
	const from = env.REMINDER_FROM;
	if (!apiKey || !from) return null;
	return createResendSender({ apiKey, from });
}
