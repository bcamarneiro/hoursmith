import type React from 'react';
import { useId, useState } from 'react';
import { trackEvent } from '../../../analytics';
import * as styles from './PremiumWaitlistForm.module.css';

/**
 * Reusable email-capture form for the Hoursmith Premium waitlist.
 *
 * Linear: ADA-268. Used on the Pricing page (ADA-267) and the in-app
 * Settings card. Posts to `/api/waitlist` (Vercel Function, ADA-269).
 *
 * The backend is intentionally tolerant — when Supabase is unset it returns
 * 200 with `saved: false`, so the user still gets a "Thanks" reply and the
 * form does not block the launch of the Pricing page.
 *
 * On a successful submit we fire the `waitlist_submitted` analytics event
 * (gated by opt-out / DNT via `trackEvent`); only the benign `source` enum is
 * sent, never the email.
 */

export type WaitlistSource = 'pricing' | 'in-app-settings';

interface Props {
	source: WaitlistSource;
	/** Optional override for tests; defaults to `/api/waitlist`. */
	endpoint?: string;
	/** Optional headline rendered above the input. */
	heading?: string;
}

type Status =
	| { kind: 'idle' }
	| { kind: 'submitting' }
	| { kind: 'success' }
	| { kind: 'error'; message: string };

// Minimal client-side check; the server is the source of truth.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PremiumWaitlistForm: React.FC<Props> = ({
	source,
	endpoint = '/api/waitlist',
	heading,
}) => {
	const inputId = useId();
	const [email, setEmail] = useState('');
	const [status, setStatus] = useState<Status>({ kind: 'idle' });

	if (status.kind === 'success') {
		return (
			<output className={styles.successCard}>
				<p className={styles.successHeadline}>Thanks. We'll let you know.</p>
				<p className={styles.successFinePrint}>
					We'll only email you about the Hoursmith Premium launch. Unsubscribe
					anytime.
				</p>
			</output>
		);
	}

	const isSubmitting = status.kind === 'submitting';

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const trimmed = email.trim();
		if (!EMAIL_RE.test(trimmed)) {
			setStatus({ kind: 'error', message: 'Please enter a valid email' });
			return;
		}
		setStatus({ kind: 'submitting' });
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email: trimmed, source }),
			});
			if (res.ok) {
				trackEvent('waitlist_submitted', { source });
				setStatus({ kind: 'success' });
				return;
			}
			if (res.status >= 400 && res.status < 500) {
				setStatus({ kind: 'error', message: 'Please enter a valid email' });
				return;
			}
			setStatus({
				kind: 'error',
				message: 'Something went wrong. Try again later.',
			});
		} catch {
			setStatus({
				kind: 'error',
				message: 'Something went wrong. Try again later.',
			});
		}
	}

	return (
		<form className={styles.form} onSubmit={handleSubmit} noValidate>
			{heading ? <p className={styles.heading}>{heading}</p> : null}
			<div className={styles.row}>
				<label htmlFor={inputId} className={styles.visuallyHidden}>
					Email address
				</label>
				<input
					id={inputId}
					type="email"
					className={styles.input}
					placeholder="you@work.com"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					disabled={isSubmitting}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					required
				/>
				<button type="submit" className={styles.button} disabled={isSubmitting}>
					{isSubmitting ? 'Sending…' : 'Notify me'}
				</button>
			</div>
			{status.kind === 'error' ? (
				<p className={styles.error} role="alert">
					{status.message}
				</p>
			) : (
				<p className={styles.finePrint}>
					We'll only email you about the Hoursmith Premium launch. Unsubscribe
					anytime.
				</p>
			)}
		</form>
	);
};
