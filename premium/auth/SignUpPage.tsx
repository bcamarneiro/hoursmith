/**
 * Sign-up page for Hoursmith Premium.
 *
 * Email/password sign-up. When Supabase "Confirm email" is enabled, signUp
 * returns no session and the user must confirm via the emailed link before they
 * can sign in — we show a "check your inbox" state for that case instead of
 * navigating to a half-authenticated /account (ADA-291). GitHub OAuth is hidden
 * until it's wired (ADA-289 / ADA-309).
 *
 * Linear: ADA-256, ADA-291, ADA-309.
 */

import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as styles from './SignUpPage.module.css';
import { useAuth } from './useAuth';

export function SignUpPage(): JSX.Element {
	useEffect(() => {
		const previous = document.title;
		document.title = 'Sign up — Hoursmith';
		return () => {
			document.title = previous;
		};
	}, []);
	const { signUp } = useAuth();
	const navigate = useNavigate();

	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

	async function handleSubmit(e: FormEvent): Promise<void> {
		e.preventDefault();
		setPending(true);
		setError(null);
		const { error: err, needsEmailConfirmation } = await signUp(
			email,
			password,
		);
		setPending(false);
		if (err) {
			setError(err);
			return;
		}
		if (needsEmailConfirmation) {
			setAwaitingConfirmation(true);
			return;
		}
		navigate('/account', { replace: true });
	}

	if (awaitingConfirmation) {
		return (
			<div className={styles.container}>
				<div className={styles.card}>
					<h1 className={styles.title}>Check your inbox</h1>
					<p className={styles.subtitle}>
						We sent a confirmation link to <strong>{email}</strong>. Click it to
						activate your account, then sign in.
					</p>
					<p className={styles.footer}>
						<Link to="/auth/sign-in">Back to sign in</Link>
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className={styles.container}>
			<div className={styles.card}>
				<h1 className={styles.title}>Create your account</h1>
				<p className={styles.subtitle}>
					Free to start. Upgrade to Premium anytime.
				</p>

				<form className={styles.form} onSubmit={handleSubmit}>
					<div className={styles.field}>
						<label className={styles.label} htmlFor="signup-email">
							Email
						</label>
						<input
							id="signup-email"
							className={styles.input}
							type="email"
							autoComplete="email"
							required
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
					</div>
					<div className={styles.field}>
						<label className={styles.label} htmlFor="signup-password">
							Password
						</label>
						<input
							id="signup-password"
							className={styles.input}
							type="password"
							autoComplete="new-password"
							required
							minLength={8}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
					</div>
					{error && (
						<p className={styles.error} role="alert">
							{error}
						</p>
					)}
					<button type="submit" className={styles.primary} disabled={pending}>
						{pending ? 'Creating account…' : 'Create account'}
					</button>
				</form>

				<p className={styles.footer}>
					Already have an account? <Link to="/auth/sign-in">Sign in</Link>
				</p>
			</div>
		</div>
	);
}
