/**
 * /account page for Hoursmith Premium.
 *
 * Sections:
 *   1. Profile      — email + signup date (from `auth.user`).
 *   2. Subscription — tier + status + renewal; CTA varies by status.
 *   3. Privacy      — export / delete account.
 *   4. Sign out.
 *
 * Subscription rows are fetched via Supabase REST against the
 * `public.subscriptions` table (RLS: select_own only). The fetch is
 * intentionally minimal — no SDK call helper today; ADA-262 will
 * follow up with a typed wrapper.
 *
 * Endpoints:
 *   - POST /api/checkout            (exists or coming via ADA-261)
 *   - POST /api/billing/portal      (ADA-262 — disabled until then)
 *   - GET  /api/account/export      (parallel PR)
 *   - POST /api/account/delete      (parallel PR)
 *
 * Linear: ADA-257.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PremiumWaitlistForm } from '../../frontend/react/components/marketing/PremiumWaitlistForm';
import { useFlags } from '../../frontend/react/hooks/useFlags';
import * as styles from './AccountPage.module.css';
import { getSupabase } from './supabaseClient';
import { useAuth } from './useAuth';

type SubscriptionStatus =
	| 'active'
	| 'past_due'
	| 'canceled'
	| 'incomplete'
	| 'trialing'
	| 'unpaid';

interface SubscriptionRow {
	tier: 'free' | 'premium';
	status: SubscriptionStatus;
	current_period_end: string | null;
}

function formatDate(value: string | null | undefined): string {
	if (!value) return '—';
	try {
		return new Date(value).toLocaleDateString();
	} catch {
		return '—';
	}
}

async function postJson(
	path: string,
	token?: string,
	body?: unknown,
): Promise<Response> {
	return fetch(path, {
		method: 'POST',
		headers: token
			? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
			: { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/**
 * The Account-page upgrade button defaults to the Hosted tier. The Pricing
 * page can route here with `?upgrade=hosted|lead` to pre-select a tier; the
 * upgrade then fires automatically so a "Get Lead" click on /pricing becomes
 * one round-trip to Polar instead of an extra click here.
 */
const DEFAULT_UPGRADE_TIER: 'hosted' | 'lead' = 'hosted';

const UPGRADE_TIER_LABELS: Record<'hosted' | 'lead', string> = {
	hosted: 'Hosted (€29/year)',
	lead: 'Lead (€60/year)',
};

export function AccountPage(): JSX.Element {
	useEffect(() => {
		const previous = document.title;
		document.title = 'Account — Hoursmith';
		return () => {
			document.title = previous;
		};
	}, []);
	const { user, session, signOut } = useAuth();
	// Operational flags (ADA-341), personalised via the session token so an
	// allowlisted user during closed launch still sees the real upgrade button.
	const flags = useFlags(session?.access_token);
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const intendedTier = useMemo<'hosted' | 'lead' | null>(() => {
		const v = searchParams.get('upgrade');
		return v === 'hosted' || v === 'lead' ? v : null;
	}, [searchParams]);
	const [subscription, setSubscription] = useState<SubscriptionRow | null>(
		null,
	);
	const [loadingSub, setLoadingSub] = useState(true);
	const [actionPending, setActionPending] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [autoUpgradeFired, setAutoUpgradeFired] = useState(false);

	useEffect(() => {
		if (!user) return;
		let cancelled = false;
		setLoadingSub(true);
		getSupabase()
			.from('subscriptions')
			.select('tier, status, current_period_end')
			.eq('user_id', user.id)
			.maybeSingle()
			.then(({ data, error }) => {
				if (cancelled) return;
				if (error) {
					console.warn('[account] subscription_fetch_failed');
					setSubscription(null);
				} else {
					setSubscription((data as SubscriptionRow | null) ?? null);
				}
				setLoadingSub(false);
			});
		return () => {
			cancelled = true;
		};
	}, [user]);

	const handleUpgrade = useCallback(
		async (tier: 'hosted' | 'lead' = DEFAULT_UPGRADE_TIER) => {
			setActionPending('checkout');
			setActionError(null);
			try {
				const res = await postJson('/api/checkout', session?.access_token, {
					tier,
				});
				if (!res.ok) throw new Error('Checkout unavailable');
				const body = (await res.json()) as { url?: string };
				if (body.url) {
					window.location.href = body.url;
					return;
				}
				throw new Error('Missing checkout URL');
			} catch (err) {
				setActionError((err as Error).message);
			} finally {
				setActionPending(null);
			}
		},
		[session],
	);

	// One-shot auto-upgrade when /account?upgrade=<tier> is set (the pricing
	// page lands here that way). We clear the query param before firing so a
	// back-button or refresh doesn't re-trigger the checkout redirect.
	// `autoUpgradeFired` makes this a fire-once effect even if handleUpgrade
	// is re-created (e.g. on session refresh).
	useEffect(() => {
		if (!intendedTier || autoUpgradeFired) return;
		if (!user || loadingSub) return;
		if (subscription?.tier === 'premium' && subscription?.status === 'active')
			return;
		// Don't auto-fire a checkout the operational gate would reject (ADA-341).
		if (!flags.checkoutEnabled || !flags.paywallOpenForMe) return;
		setAutoUpgradeFired(true);
		const next = new URLSearchParams(searchParams);
		next.delete('upgrade');
		setSearchParams(next, { replace: true });
		void handleUpgrade(intendedTier);
	}, [
		intendedTier,
		autoUpgradeFired,
		user,
		loadingSub,
		subscription,
		searchParams,
		setSearchParams,
		handleUpgrade,
		flags.checkoutEnabled,
		flags.paywallOpenForMe,
	]);

	const handleExport = useCallback(async () => {
		setActionPending('export');
		setActionError(null);
		try {
			const res = await fetch('/api/account/export', {
				headers: session?.access_token
					? { authorization: `Bearer ${session.access_token}` }
					: undefined,
			});
			if (!res.ok) throw new Error('Export endpoint not available yet.');
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'hoursmith-account-export.json';
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			setActionError((err as Error).message);
		} finally {
			setActionPending(null);
		}
	}, [session]);

	const handleDelete = useCallback(async () => {
		const confirmed = window.confirm(
			'Delete your account? This removes your profile and subscription record. This cannot be undone.',
		);
		if (!confirmed) return;
		setActionPending('delete');
		setActionError(null);
		try {
			const res = await postJson('/api/account/delete', session?.access_token);
			if (!res.ok) throw new Error('Delete endpoint not available yet.');
			await signOut();
			navigate('/', { replace: true });
		} catch (err) {
			setActionError((err as Error).message);
		} finally {
			setActionPending(null);
		}
	}, [session, signOut, navigate]);

	const handlePortal = useCallback(async () => {
		setActionPending('portal');
		setActionError(null);
		try {
			const res = await postJson('/api/billing/portal', session?.access_token);
			if (res.status === 404) {
				throw new Error(
					'No billing history yet. Upgrade to Premium to get a Customer Portal session.',
				);
			}
			if (!res.ok) throw new Error('Customer Portal is unavailable right now.');
			const body = (await res.json()) as { url?: string };
			if (body.url) {
				window.location.assign(body.url);
				return;
			}
			throw new Error('Missing Customer Portal URL.');
		} catch (err) {
			setActionError((err as Error).message);
		} finally {
			setActionPending(null);
		}
	}, [session]);

	const handleSignOut = useCallback(async () => {
		await signOut();
		navigate('/', { replace: true });
	}, [signOut, navigate]);

	if (!user) {
		// RequireAuth should have redirected; render nothing as a safety net.
		return <div />;
	}

	const status = subscription?.status ?? null;
	const tier = subscription?.tier ?? 'free';

	return (
		<div className={styles.container}>
			<h1 className={styles.title}>Account</h1>

			<section className={styles.section}>
				<h2 className={styles.sectionTitle}>Profile</h2>
				<div className={styles.row}>
					<span className={styles.label}>Email</span>
					<span className={styles.value}>{user.email ?? '—'}</span>
				</div>
				<div className={styles.row}>
					<span className={styles.label}>Member since</span>
					<span className={styles.value}>{formatDate(user.created_at)}</span>
				</div>
			</section>

			<section className={styles.section}>
				<h2 className={styles.sectionTitle}>Subscription</h2>
				{loadingSub ? (
					<p className={styles.note}>Loading…</p>
				) : (
					<>
						<div className={styles.row}>
							<span className={styles.label}>Tier</span>
							<span className={styles.value}>
								{tier === 'premium' ? 'Premium' : 'Free'}
							</span>
						</div>
						<div className={styles.row}>
							<span className={styles.label}>Status</span>
							<span className={styles.value}>{status ?? 'none'}</span>
						</div>
						{subscription?.current_period_end && (
							<div className={styles.row}>
								<span className={styles.label}>
									{status === 'canceled' ? 'Ends' : 'Renews'}
								</span>
								<span className={styles.value}>
									{formatDate(subscription.current_period_end)}
								</span>
							</div>
						)}

						{status === 'past_due' && (
							<div className={styles.alert}>
								Payment failed — please update your card to keep Premium access.
							</div>
						)}

						<div className={styles.actions}>
							{(!status || status === 'incomplete' || tier === 'free') &&
								(!flags.checkoutEnabled ? (
									<p className={styles.note}>
										Checkout is temporarily unavailable.
									</p>
								) : !flags.paywallOpenForMe ? (
									<PremiumWaitlistForm source="in-app-settings" />
								) : (
									<button
										type="button"
										className={styles.primary}
										onClick={() =>
											handleUpgrade(intendedTier ?? DEFAULT_UPGRADE_TIER)
										}
										disabled={actionPending === 'checkout'}
									>
										{actionPending === 'checkout'
											? 'Redirecting…'
											: `Upgrade to ${
													UPGRADE_TIER_LABELS[
														intendedTier ?? DEFAULT_UPGRADE_TIER
													]
												}`}
									</button>
								))}
							{status === 'canceled' &&
								(!flags.checkoutEnabled ? (
									<p className={styles.note}>
										Checkout is temporarily unavailable.
									</p>
								) : !flags.paywallOpenForMe ? (
									<PremiumWaitlistForm source="in-app-settings" />
								) : (
									<button
										type="button"
										className={styles.primary}
										onClick={() =>
											handleUpgrade(intendedTier ?? DEFAULT_UPGRADE_TIER)
										}
										disabled={actionPending === 'checkout'}
									>
										Resubscribe
									</button>
								))}
							{(status === 'active' ||
								status === 'past_due' ||
								status === 'trialing' ||
								status === 'unpaid') && (
								<button
									type="button"
									className={styles.secondary}
									onClick={handlePortal}
									disabled={actionPending === 'portal'}
								>
									{actionPending === 'portal'
										? 'Redirecting…'
										: status === 'past_due'
											? 'Update payment method'
											: status === 'unpaid'
												? 'Resolve unpaid invoice'
												: 'Manage billing'}
								</button>
							)}
						</div>
					</>
				)}
			</section>

			<section className={styles.section}>
				<h2 className={styles.sectionTitle}>Privacy</h2>
				<p className={styles.note}>
					Export a copy of your account data or delete your account.
				</p>
				<div className={styles.actions}>
					<button
						type="button"
						className={styles.secondary}
						onClick={handleExport}
						disabled={actionPending === 'export'}
					>
						{actionPending === 'export' ? 'Exporting…' : 'Export my data'}
					</button>
					<button
						type="button"
						className={styles.danger}
						onClick={handleDelete}
						disabled={actionPending === 'delete'}
					>
						{actionPending === 'delete' ? 'Deleting…' : 'Delete my account'}
					</button>
				</div>
			</section>

			<section className={styles.section}>
				<h2 className={styles.sectionTitle}>Session</h2>
				<div className={styles.actions}>
					<button
						type="button"
						className={styles.secondary}
						onClick={handleSignOut}
					>
						Sign out
					</button>
				</div>
			</section>

			{actionError && <p className={styles.alert}>{actionError}</p>}
		</div>
	);
}
