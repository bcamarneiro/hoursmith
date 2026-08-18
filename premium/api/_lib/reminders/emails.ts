import type { EmailMessage, LeadDigest, MemberNudge } from './types.js';

/**
 * Reminder email templates (ADA-546). Pure: build `{subject, text, html}` from a
 * planned nudge/digest. The voice is deliberately relief-framed, carrying the
 * ADA-479 stance into email — a nudge, not a chase; completeness is a
 * timeliness signal, never a productivity/performance measure.
 */

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/** Wrap text lines in a minimal, client-safe HTML document. */
function htmlDoc(paragraphs: string[]): string {
	const body = paragraphs
		.map((p) => `<p style="margin:0 0 12px">${p}</p>`)
		.join('');
	return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${body}</body></html>`;
}

const FOOTER_TEXT =
	'This is about keeping the timesheet record complete and on time — not a measure of your productivity. You can turn these reminders off in your team settings.';

export function buildMemberNudgeEmail(nudge: MemberNudge): EmailMessage {
	const name = nudge.displayName || 'there';
	const due = nudge.period.dueLabel ? ` (due ${nudge.period.dueLabel})` : '';

	const subject = `A quick nudge: your worklogs for ${nudge.period.label}`;
	const lines = [
		`Hi ${name},`,
		`Your Jira worklogs for ${nudge.period.label} look incomplete${due}. A few minutes now saves the month-end scramble — no need for it to be perfect, just complete.`,
		FOOTER_TEXT,
	];

	return {
		to: nudge.to,
		subject,
		text: lines.join('\n\n'),
		html: htmlDoc([
			`Hi ${escapeHtml(name)},`,
			`Your Jira worklogs for ${escapeHtml(nudge.period.label)} look incomplete${escapeHtml(due)}. A few minutes now saves the month-end scramble — no need for it to be perfect, just complete.`,
			escapeHtml(FOOTER_TEXT),
		]),
	};
}

export function buildLeadDigestEmail(digest: LeadDigest): EmailMessage {
	const teamPrefix = digest.teamName ? `${digest.teamName}: ` : '';
	const count = digest.behind.length;
	const noun = count === 1 ? 'person' : 'people';

	const subject = `${teamPrefix}${count} ${noun} still to log for ${digest.period.label}`;
	const names = digest.behind.map((m) => m.displayName);

	const textLines = [
		`${count} ${noun} on your team haven't finished logging ${digest.period.label} yet:`,
		names.map((n) => `• ${n}`).join('\n'),
		'Worth a nudge or a hand — a shared gap is often a process or workload signal, not a ranking.',
	];

	const htmlItems = digest.behind
		.map((m) => `<li>${escapeHtml(m.displayName)}</li>`)
		.join('');

	return {
		to: digest.to,
		subject,
		text: textLines.join('\n\n'),
		html: htmlDoc([
			`${count} ${noun} on your team haven't finished logging ${escapeHtml(digest.period.label)} yet:`,
			`<ul style="margin:0 0 12px;padding-left:20px">${htmlItems}</ul>`,
			'Worth a nudge or a hand — a shared gap is often a process or workload signal, not a ranking.',
		]),
	};
}
