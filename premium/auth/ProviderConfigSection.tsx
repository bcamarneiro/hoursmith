/**
 * Provider Configuration section for Hoursmith Premium (ADA-271, ADA-523).
 *
 * Lets users securely store and manage API keys for external service
 * providers (Jira, GitLab, GitHub, etc.) and test connections before saving.
 *
 * Provider tokens are encrypted at rest in the `user_tokens` table (ADA-648).
 * The encryption key (service-role) is never exposed to the client — all
 * token operations go through the authenticated `/api/providerConfig/*`
 * endpoints.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './useAuth';
import * as styles from './ProviderConfigSection.module.css';

// ── Types ──

type TokenProvider =
	| 'jira_api'
	| 'gitlab'
	| 'rescuetime'
	| 'github'
	| 'toggl'
	| 'harvest'
	| 'clockify'
	| 'custom';

interface PublicToken {
	provider: TokenProvider;
	label: string | null;
	status: string;
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
}

interface TestResult {
	ok: boolean;
	provider: string;
	label?: string;
	error?: string;
	note?: string;
}

interface FormState {
	provider: TokenProvider;
	apiKey: string;
	host: string;
	label: string;
}

// ── Constants ──

const PROVIDERS: Array<{ id: TokenProvider; label: string; hostPlaceholder: string }> = [
	{ id: 'jira_api', label: 'Jira Cloud', hostPlaceholder: 'https://your-domain.atlassian.net' },
	{ id: 'gitlab', label: 'GitLab', hostPlaceholder: 'https://gitlab.com' },
	{ id: 'github', label: 'GitHub', hostPlaceholder: '' },
	{ id: 'rescuetime', label: 'RescueTime', hostPlaceholder: '' },
	{ id: 'toggl', label: 'Toggl Track', hostPlaceholder: '' },
	{ id: 'harvest', label: 'Harvest', hostPlaceholder: '' },
	{ id: 'clockify', label: 'Clockify', hostPlaceholder: '' },
	{ id: 'custom', label: 'Custom', hostPlaceholder: '' },
];

const PROVIDER_HOSTS: Partial<Record<TokenProvider, string>> = {
	jira_api: 'https://your-domain.atlassian.net',
	gitlab: 'https://gitlab.com',
};

const EMPTY_FORM: FormState = {
	provider: 'jira_api',
	apiKey: '',
	host: '',
	label: '',
};

function providerLabel(id: TokenProvider): string {
	return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

// ── Component ──

export function ProviderConfigSection(): JSX.Element {
	const { session } = useAuth();
	const token = session?.access_token ?? null;

	// Stored tokens
	const [tokens, setTokens] = useState<PublicToken[]>([]);
	const [tokensLoading, setTokensLoading] = useState(true);
	const [tokensError, setTokensError] = useState<string | null>(null);

	// Inline form
	const [isAdding, setIsAdding] = useState(false);
	const [editingProvider, setEditingProvider] = useState<string | null>(null);
	const [form, setForm] = useState<FormState>(EMPTY_FORM);

	// Connection test
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<TestResult | null>(null);

	// Save / delete
	const [saving, setSaving] = useState(false);
	const [deletingProvider, setDeletingProvider] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null);

	// ── Fetch tokens ──

	const fetchTokens = useCallback(async () => {
		if (!token) return;
		setTokensLoading(true);
		setTokensError(null);
		try {
			const res = await fetch('/api/providerConfig/tokens', {
				headers: { authorization: `Bearer ${token}` },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
				throw new Error((body.error as string) ?? `HTTP ${res.status}`);
			}
			const body = (await res.json()) as { tokens: PublicToken[] };
			setTokens(body.tokens ?? []);
		} catch (err) {
			setTokensError((err as Error).message);
		} finally {
			setTokensLoading(false);
		}
	}, [token]);

	useEffect(() => {
		fetchTokens().catch(() => {});
	}, [fetchTokens]);

	// ── Form handlers ──

	function resetForm(): void {
		setForm(EMPTY_FORM);
		setTestResult(null);
		setEditingProvider(null);
	}

	function openAdd(): void {
		resetForm();
		setFeedback(null);
		setIsAdding(true);
	}

	function cancelAdd(): void {
		setIsAdding(false);
		resetForm();
		setFeedback(null);
	}

	function openEdit(t: PublicToken): void {
		setForm({
			provider: t.provider,
			apiKey: '',
			host: '',
			label: t.label ?? '',
		});
		setEditingProvider(t.provider);
		setTestResult(null);
		setFeedback(null);
		setIsAdding(true);
	}

	async function handleTestConnection(): Promise<void> {
		if (!token || !form.apiKey.trim()) return;
		setTesting(true);
		setTestResult(null);
		try {
			const body: Record<string, string> = {
				provider: form.provider,
				apiKey: form.apiKey.trim(),
			};
			if (form.host.trim()) {
				body.host = form.host.trim();
			}
			const res = await fetch('/api/providerConfig/test', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
			});
			const data = (await res.json()) as TestResult;
			setTestResult(data);
			if (data.ok && data.label && !form.label) {
				setForm((prev) => ({ ...prev, label: data.label ?? prev.label }));
			}
		} catch (err) {
			setTestResult({
				ok: false,
				provider: form.provider,
				error: 'Could not reach the server. Check your network connection.',
			});
		} finally {
			setTesting(false);
		}
	}

	async function handleSave(): Promise<void> {
		if (!token) return;
		setSaving(true);
		setFeedback(null);
		try {
			const res = await fetch('/api/providerConfig/tokens', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					provider: form.provider,
					apiKey: form.apiKey.trim(),
					label: form.label.trim() || null,
				}),
			});
			if (!res.ok) {
				const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
				throw new Error((errBody.error as string) ?? `HTTP ${res.status}`);
			}
			setFeedback(`API key saved for ${providerLabel(form.provider)}.`);
			setIsAdding(false);
			resetForm();
			await fetchTokens();
		} catch (err) {
			setFeedback(`Error: ${(err as Error).message}`);
		} finally {
			setSaving(false);
		}
	}

	async function handleDelete(provider: string): Promise<void> {
		if (!token) return;
		setDeletingProvider(provider);
		setFeedback(null);
		try {
			const res = await fetch(
				`/api/providerConfig/tokens?provider=${encodeURIComponent(provider)}`,
				{
					method: 'DELETE',
					headers: { authorization: `Bearer ${token}` },
				},
			);
			if (!res.ok && res.status !== 404) {
				const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
				throw new Error((errBody.error as string) ?? `HTTP ${res.status}`);
			}
			setFeedback(`API key removed for ${providerLabel(provider as TokenProvider)}.`);
			await fetchTokens();
		} catch (err) {
			setFeedback(`Error: ${(err as Error).message}`);
		} finally {
			setDeletingProvider(null);
		}
	}

	// ── Render ──

	return (
		<section className={styles.section}>
			<h2 className={styles.heading}>Provider API Keys</h2>
			<p className={styles.description}>
				Store API keys for external services. Keys are encrypted at rest and
				never stored in plaintext. Use them to power Jira time tracking,
				GitLab activity, and more.
			</p>

			{/* ── Token list ── */}
			{tokensLoading ? (
				<p className={styles.muted}>Loading configured providers…</p>
			) : tokensError ? (
				<p className={styles.error}>
					Could not load providers: {tokensError}
				</p>
			) : tokens.length === 0 ? (
				<p className={styles.muted}>No API keys configured yet.</p>
			) : (
				<ul className={styles.tokenList}>
					{tokens.map((t) => (
						<li key={t.provider} className={styles.tokenItem}>
							<div className={styles.tokenInfo}>
								<span className={styles.tokenProvider}>
									{providerLabel(t.provider)}
								</span>
								{t.label && (
									<span className={styles.tokenLabel}>{t.label}</span>
								)}
								<span
									className={`${styles.tokenStatus} ${
										t.status === 'active'
											? styles.statusActive
											: t.status === 'expired'
												? styles.statusExpired
												: styles.statusRevoked
									}`}
								>
									{t.status}
								</span>
							</div>
							<div className={styles.tokenActions}>
								<button
									type="button"
									className={styles.editButton}
									onClick={() => openEdit(t)}
								>
									Update
								</button>
								<button
									type="button"
									className={styles.deleteButton}
									disabled={deletingProvider === t.provider}
									onClick={() => handleDelete(t.provider)}
								>
									{deletingProvider === t.provider ? 'Removing…' : 'Remove'}
								</button>
							</div>
						</li>
					))}
				</ul>
			)}

			{/* ── Add button ── */}
			{!isAdding && (
				<button type="button" className={styles.addButton} onClick={openAdd}>
					Add API Key
				</button>
			)}

			{/* ── Inline form ── */}
			{isAdding && (
				<div className={styles.formCard}>
					<h3 className={styles.formHeading}>
						{editingProvider ? 'Update API Key' : 'Add API Key'}
					</h3>

					{/* Provider selector */}
					<div className={styles.field}>
						<label htmlFor="provider-select" className={styles.label}>
							Provider
						</label>
						<select
							id="provider-select"
							className={styles.select}
							value={form.provider}
							onChange={(e) => {
								const p = e.target.value as TokenProvider;
								setForm({
									provider: p,
									apiKey: '',
									host: PROVIDER_HOSTS[p] ?? '',
									label: '',
								});
								setTestResult(null);
							}}
						>
							{PROVIDERS.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label}
								</option>
							))}
						</select>
					</div>

					{/* Host (only for providers that need it) */}
					{PROVIDER_HOSTS[form.provider] !== undefined && (
						<div className={styles.field}>
							<label htmlFor="provider-host" className={styles.label}>
								Host URL
							</label>
							<input
								id="provider-host"
								className={styles.input}
								type="text"
								placeholder={
									PROVIDERS.find((p) => p.id === form.provider)
										?.hostPlaceholder ?? ''
								}
								value={form.host}
								onChange={(e) =>
									setForm((prev) => ({ ...prev, host: e.target.value }))
								}
							/>
						</div>
					)}

					{/* API Key */}
					<div className={styles.field}>
						<label htmlFor="provider-apikey" className={styles.label}>
							API Key
						</label>
						<input
							id="provider-apikey"
							className={styles.input}
							type="password"
							placeholder="Paste your API key or token"
							autoComplete="off"
							value={form.apiKey}
							onChange={(e) =>
								setForm((prev) => ({ ...prev, apiKey: e.target.value }))
							}
						/>
					</div>

					{/* Label */}
					<div className={styles.field}>
						<label htmlFor="provider-label" className={styles.label}>
							Label <span className={styles.optional}>(optional)</span>
						</label>
						<input
							id="provider-label"
							className={styles.input}
							type="text"
							placeholder='e.g. "Work account"'
							value={form.label}
							onChange={(e) =>
								setForm((prev) => ({ ...prev, label: e.target.value }))
							}
						/>
					</div>

					{/* Test result */}
					{testResult && (
						<div
							className={`${styles.testResult} ${
								testResult.ok ? styles.testSuccess : styles.testFail
							}`}
						>
							{testResult.ok
								? `Connection successful${testResult.label ? ` — ${testResult.label}` : ''}`
								: testResult.error}
						</div>
					)}

					{/* Actions */}
					<div className={styles.formActions}>
						<button
							type="button"
							className={styles.testButton}
							disabled={testing || !form.apiKey.trim()}
							onClick={handleTestConnection}
						>
							{testing ? 'Testing…' : 'Test Connection'}
						</button>
						<button
							type="button"
							className={styles.saveButton}
							disabled={saving || !form.apiKey.trim()}
							onClick={handleSave}
						>
							{saving ? 'Saving…' : 'Save'}
						</button>
						<button
							type="button"
							className={styles.cancelButton}
							disabled={saving || testing}
							onClick={cancelAdd}
						>
							Cancel
						</button>
					</div>
				</div>
			)}

			{/* Feedback — rendered outside the form so it persists after close */}
			{feedback && (
				<p
					className={`${styles.feedback} ${
						feedback.startsWith('Error') ? styles.error : styles.success
					}`}
				>
					{feedback}
				</p>
			)}
		</section>
	);
}
