/**
 * Server-side encrypted token storage for Hoursmith Premium (ADA-648).
 *
 * Stores encrypted third-party API tokens (Jira, GitLab, etc.) in the
 * `user_tokens` table so the hosted proxy can inject them server-side.
 * Tokens are encrypted at rest; this module only handles the encrypted
 * payload — encryption/decryption is a separate concern.
 *
 * Dependency-free `fetch` wrapper following the same pattern as
 * `supabaseAdmin.ts`. The store is injectable so unit tests run offline.
 *
 * Linear: ADA-648.
 */

export type TokenProvider =
	| 'jira_api'
	| 'gitlab'
	| 'rescuetime'
	| 'github'
	| 'toggl'
	| 'harvest'
	| 'clockify'
	| 'custom';

export type TokenStatus = 'active' | 'revoked' | 'expired';

export interface UserToken {
	id: string;
	user_id: string;
	provider: TokenProvider;
	label: string | null;
	encrypted_value: string;
	status: TokenStatus;
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
}

export interface TokenUpsert {
	provider: TokenProvider;
	label?: string;
	encrypted_value: string;
	/** Defaults to 'active' when omitted. */
	status?: TokenStatus;
}

/**
 * Inject to pin a user (and bypass JWT lookup) in tests where we don't want
 * to wire up a full auth flow.
 */
export interface TokenStorageEnv {
	SUPABASE_URL?: string;
	SUPABASE_SERVICE_ROLE_KEY?: string;
}

export interface TokenStorage {
	/** Get a single token by user + provider; null if none exists. */
	getToken(userId: string, provider: TokenProvider): Promise<UserToken | null>;
	/** Insert or overwrite a token for (user, provider). */
	upsertToken(userId: string, input: TokenUpsert): Promise<UserToken>;
	/** List every token for a user (any status). */
	listTokens(userId: string): Promise<UserToken[]>;
	/**
	 * Transition a token to 'revoked' without deleting the row. Returns the
	 * updated row or null if no active/expired token existed for that provider.
	 */
	revokeToken(
		userId: string,
		provider: TokenProvider,
	): Promise<UserToken | null>;
	/** Hard-delete a token row. Returns true if a row was deleted. */
	deleteToken(userId: string, provider: TokenProvider): Promise<boolean>;
	/** Bump last_used_at to now for the matching token. */
	bumpLastUsed(userId: string, provider: TokenProvider): Promise<void>;
}

export function makeTokenStorage(env: TokenStorageEnv): TokenStorage {
	const url = env.SUPABASE_URL;
	const key = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) {
		throw new Error(
			'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for tokenStorage.',
		);
	}
	return new FetchTokenStorage(url, key);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class FetchTokenStorage implements TokenStorage {
	constructor(
		private readonly url: string,
		private readonly serviceRoleKey: string,
	) {}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		return {
			apikey: this.serviceRoleKey,
			authorization: `Bearer ${this.serviceRoleKey}`,
			accept: 'application/json',
			...extra,
		};
	}

	private rootUrl(): string {
		return `${this.url}/rest/v1/user_tokens`;
	}

	async getToken(
		userId: string,
		provider: TokenProvider,
	): Promise<UserToken | null> {
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			provider: `eq.${provider}`,
			select: '*',
		});
		const res = await fetch(`${this.rootUrl()}?${params.toString()}`, {
			headers: this.headers(),
		});
		if (!res.ok) {
			throw new Error(`tokenStorage.getToken failed: ${res.status}`);
		}
		const rows = (await res.json()) as UserToken[];
		return rows[0] ?? null;
	}

	async upsertToken(userId: string, input: TokenUpsert): Promise<UserToken> {
		const body: Record<string, unknown> = {
			user_id: userId,
			provider: input.provider,
			encrypted_value: input.encrypted_value,
			status: input.status ?? 'active',
			last_used_at: null,
		};
		if (input.label !== undefined) body.label = input.label;

		const res = await fetch(this.rootUrl(), {
			method: 'POST',
			headers: this.headers({
				'content-type': 'application/json',
				prefer: 'resolution=merge-duplicates,return=representation',
			}),
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`tokenStorage.upsertToken failed: ${res.status}`);
		}
		const rows = (await res.json()) as UserToken[];
		if (rows.length === 0) {
			throw new Error('tokenStorage.upsertToken: no row returned');
		}
		return rows[0];
	}

	async listTokens(userId: string): Promise<UserToken[]> {
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			select: '*',
			order: 'created_at.desc',
		});
		const res = await fetch(`${this.rootUrl()}?${params.toString()}`, {
			headers: this.headers(),
		});
		if (!res.ok) {
			throw new Error(`tokenStorage.listTokens failed: ${res.status}`);
		}
		return (await res.json()) as UserToken[];
	}

	async revokeToken(
		userId: string,
		provider: TokenProvider,
	): Promise<UserToken | null> {
		// PATCH active/expired → revoked via PostgREST. The filter ensures
		// we only touch the row if it's in a revocable state.
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			provider: `eq.${provider}`,
			status: 'in.(active,expired)',
		});
		const res = await fetch(`${this.rootUrl()}?${params.toString()}`, {
			method: 'PATCH',
			headers: this.headers({
				'content-type': 'application/json',
				prefer: 'return=representation',
			}),
			body: JSON.stringify({ status: 'revoked' }),
		});
		if (!res.ok) {
			throw new Error(`tokenStorage.revokeToken failed: ${res.status}`);
		}
		const rows = (await res.json()) as UserToken[];
		return rows[0] ?? null;
	}

	async deleteToken(userId: string, provider: TokenProvider): Promise<boolean> {
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			provider: `eq.${provider}`,
		});
		const res = await fetch(`${this.rootUrl()}?${params.toString()}`, {
			method: 'DELETE',
			headers: this.headers({ prefer: 'return=representation' }),
		});
		if (!res.ok) {
			throw new Error(`tokenStorage.deleteToken failed: ${res.status}`);
		}
		const rows = (await res.json()) as UserToken[];
		return rows.length > 0;
	}

	async bumpLastUsed(userId: string, provider: TokenProvider): Promise<void> {
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			provider: `eq.${provider}`,
			status: 'eq.active',
		});
		const res = await fetch(`${this.rootUrl()}?${params.toString()}`, {
			method: 'PATCH',
			headers: this.headers({
				'content-type': 'application/json',
				prefer: 'return=minimal',
			}),
			body: JSON.stringify({ last_used_at: new Date().toISOString() }),
		});
		if (!res.ok) {
			throw new Error(`tokenStorage.bumpLastUsed failed: ${res.status}`);
		}
	}
}
