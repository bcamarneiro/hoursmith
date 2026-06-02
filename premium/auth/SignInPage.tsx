/**
 * Sign-in page for Hoursmith Premium.
 *
 * Email/password sign-in. Redirects to `/account` on success, or to the
 * `?redirect=` target if RequireAuth bounced the user here. GitHub OAuth is
 * hidden until it's wired (ADA-289 / ADA-309).
 *
 * Linear: ADA-256, ADA-309.
 */

import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as styles from './SignInPage.module.css';
import { useAuth } from './useAuth';

export function SignInPage(): JSX.Element {
	useEffect(() => {
		const previous = document.title;
		document.title = 'Sign in — Hoursmith';
		return () => {
			document.title = previous;
		};
	}, []);
	const { signIn } = useAuth();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const redirect = params.get('redirect') || '/account';

	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function handleSubmit(e: FormEvent): Promise<void> {
		e.preventDefault();
		setPending(true);
		setError(null);
		const { error: err } = await signIn(email, password);
		setPending(false);
		if (err) {
			setError(err);
			return;
		}
		navigate(redirect, { replace: true });
	}

	return (
		<div className={styles.container}>
			<div className={styles.card}>
				<h1 className={styles.title}>Sign in</h1>
				<p className={styles.subtitle}>
					Access your Hoursmith Premium account.
				</p>

				<form className={styles.form} onSubmit={handleSubmit}>
					<div className={styles.field}>
						<label className={styles.label} htmlFor="signin-email">
							Email
						</label>
						<input
							id="signin-email"
							className={styles.input}
							type="email"
							autoComplete="email"
							required
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
					</div>
					<div className={styles.field}>
						<label className={styles.label} htmlFor="signin-password">
							Password
						</label>
						<input
							id="signin-password"
							className={styles.input}
							type="password"
							autoComplete="current-password"
							required
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
						{pending ? 'Signing in…' : 'Sign in'}
					</button>
				</form>

				<p className={styles.footer}>
					No account? <Link to="/auth/sign-up">Create one</Link>
				</p>
			</div>
		</div>
	);
}
