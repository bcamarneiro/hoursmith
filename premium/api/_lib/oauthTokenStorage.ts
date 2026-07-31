/**
 * Server-side encrypted OAuth token storage for Hoursmith Premium (ADA-680).
 *
 * Stores encrypted OAuth credentials (access token, refresh token, expiry)
 * in the `oauth_tokens` table so server-side integrations can refresh and use
 * them without plaintext ever landing in a browser context.
 * Tokens are encrypted at rest; this module only handles the encrypted
 * payload — encryption/decryption is a separate concern.
 *
 * Dependency-free `fetch` wrapper following the same pattern as
 * `tokenStorage.ts` and `supabaseAdmin.ts`. The store is injectable so
 * unit tests run offline.
 *
 * Linear: ADA-680.
 */

export type OAuthProvider =
	| 'jira_oauth'
	| 'gitlab_oauth'
	| 'github_oauth'
	| 'custom';

export type OAuthTokenStatus = 'active' | 'revoked';

export interface OAuthToken {
	id: string;
	user_id: string;
	provider: OAuthProvider;
	label: string | null;
	encrypted_access_token: string;
	encrypted_refresh_token: string | null;
	expires_at: string | null;
	token_type: string | null;
	scope: string | null;
	status: OAuthTokenStatus;
	created_at: string;
	updated_at: string;
}

export interface OAuthTokenUpsert {
	provider: OAuthProvider;
	label?: string;
	encrypted_access_token: string;
	encrypted_refresh_token?: string | null;
	expires_at?: string | null;
	token_type?: string | null;
	scope?: string | null;
	/** Defaults to 'active' when omitted. */
	status?: OAuthTokenStatus;
}

/**
 * Inject to pin environment variables in tests where we don't want
 * to wire up real process.env.
 */
export interface OAuthTokenStorageEnv {
	SUPABASE_URL?: string;
	SUPABASE_SERVICE_ROLE_KEY?: string;
}

export interface OAuthTokenStorage {
	/**
	 * Get a single OAuth token by user + provider; null if none exists.
	 */
	getToken(userId: string, provider: OAuthProvider): Promise<OAuthToken | null>;
	/**
	 * Insert or overwrite an OAuth token for (user, provider).
	 */
	upsertToken(
		userId: string,
		input: OAuthTokenUpsert,
	): Promise<OAuthToken>;
	/**
	 * List every OAuth token for a user (any status).
	 */
	listTokens(userId: string): Promise<OAuthToken[]>;
	/**
	 * Transition a token to 'revoked' without deleting the row. Returns the
	 * updated row or null if no active token existed for that provider.
	 */
	revokeToken(
		userId: string,
		provider: OAuthProvider,
	): Promise<OAuthToken | null>;
	/**
	 * Hard-delete a token row. Returns true if a row was deleted.
	 */
	deleteToken(userId: string, provider: OAuthProvider): Promise<boolean>;
}

export function makeOAuthTokenStorage(
	env: OAuthTokenStorageEnv,
): OAuthTokenStorage {
	const url = env.SUPABASE_URL;
	const key = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) {
		throw new Error(
			'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for oauthTokenStorage.',
		);
	}
	return new FetchOAuthTokenStorage(url, key);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class FetchOAuthTokenStorage implements OAuthTokenStorage {
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
		return `${this.url}/rest/v1/oauth_tokens`;
	}

	async getToken(
		userId: string,
		provider: OAuthProvider,
	): Promise<OAuthToken | null> {
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			provider: `eq.${provider}`,
			select: '*',
		});
		const res = await fetch(`${this.rootUrl()}?${params.toString()}`, {
			headers: this.headers(),
		});
		if (!res.ok) {
			throw new Error(`oauthTokenStorage.getToken failed: ${res.status}`);
		}
		const rows = (await res.json()) as OAuthToken[];
		return rows[0] ?? null;
	}

	async upsertToken(
		userId: string,
		input: OAuthTokenUpsert,
	): Promise<OAuthToken> {
		const body: Record<string, unknown> = {
			user_id: userId,
			provider: input.provider,
			encrypted_access_token: input.encrypted_access_token,
			encrypted_refresh_token: input.encrypted_refresh_token ?? null,
			expires_at: input.expires_at ?? null,
			token_type: input.token_type ?? null,
			scope: input.scope ?? null,
			status: input.status ?? 'active',
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
			throw new Error(`oauthTokenStorage.upsertToken failed: ${res.status}`);
		}
		const rows = (await res.json()) as OAuthToken[];
		if (rows.length === 0) {
			throw new Error('oauthTokenStorage.upsertToken: no row returned');
		}
		return rows[0];
	}

	async listTokens(userId: string): Promise<OAuthToken[]> {
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			select: '*',
			order: 'created_at.desc',
		});
		const res = await fetch(`${this.rootUrl()}?${params.toString()}`, {
			headers: this.headers(),
		});
		if (!res.ok) {
			throw new Error(`oauthTokenStorage.listTokens failed: ${res.status}`);
		}
		return (await res.json()) as OAuthToken[];
	}

	async revokeToken(
		userId: string,
		provider: OAuthProvider,
	): Promise<OAuthToken | null> {
		// PATCH active → revoked via PostgREST. The filter ensures
		// we only touch the row if it's in a revocable state.
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			provider: `eq.${provider}`,
			status: 'eq.active',
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
			throw new Error(`oauthTokenStorage.revokeToken failed: ${res.status}`);
		}
		const rows = (await res.json()) as OAuthToken[];
		return rows[0] ?? null;
	}

	async deleteToken(
		userId: string,
		provider: OAuthProvider,
	): Promise<boolean> {
		const params = new URLSearchParams({
			user_id: `eq.${userId}`,
			provider: `eq.${provider}`,
		});
		const res = await fetch(`${this.rootUrl()}?${params.toString()}`, {
			method: 'DELETE',
			headers: this.headers({ prefer: 'return=representation' }),
		});
		if (!res.ok) {
			throw new Error(`oauthTokenStorage.deleteToken failed: ${res.status}`);
		}
		const rows = (await res.json()) as OAuthToken[];
		return rows.length > 0;
	}
}
