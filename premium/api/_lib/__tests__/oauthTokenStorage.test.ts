/**
 * Tests for the OAuth token storage module (ADA-680).
 *
 * The store is injected, so these run with no network. We assert the full
 * token lifecycle: create → get → upsert (refresh) → list → revoke → delete,
 * plus per-user isolation, idempotent upsert, and error propagation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	makeOAuthTokenStorage,
	type OAuthToken,
	type OAuthTokenStorage,
} from '../oauthTokenStorage.js';

/** Stub fetch to run oauthTokenStorage offline. */
function stubFetch(
	handler: (input: RequestInfo, init?: RequestInit) => Response,
): typeof globalThis.fetch {
	const stub = vi.fn(
		(input: RequestInfo, init?: RequestInit) =>
			new Promise<Response>((resolve) => resolve(handler(input, init))),
	);
	// biome-ignore lint/suspicious/noExplicitAny: TS global fetch type
	vi.stubGlobal('fetch', stub as any);
	return stub as unknown as typeof globalThis.fetch;
}

function tokenStore(): OAuthTokenStorage {
	return makeOAuthTokenStorage({
		SUPABASE_URL: 'http://localhost:54321',
		SUPABASE_SERVICE_ROLE_KEY: 'test-key',
	});
}

function fakeToken(overrides: Partial<OAuthToken> = {}): OAuthToken {
	return {
		id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
		user_id: 'usr_1',
		provider: 'jira_oauth',
		label: null,
		encrypted_access_token: 'aes256gcm:access-deadbeef',
		encrypted_refresh_token: 'aes256gcm:refresh-cafebabe',
		expires_at: '2026-08-01T00:00:00.000Z',
		token_type: 'Bearer',
		scope: 'read:jira-work offline_access',
		status: 'active',
		created_at: '2026-07-31T00:00:00.000Z',
		updated_at: '2026-07-31T00:00:00.000Z',
		...overrides,
	};
}

describe('oauthTokenStorage', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// -----------------------------------------------------------------------
	// upsertToken
	// -----------------------------------------------------------------------

	it('upsertToken creates a new active token with all fields', async () => {
		const token = fakeToken();
		stubFetch(() => Response.json([token], { status: 201 }));
		const store = tokenStore();

		const result = await store.upsertToken('usr_1', {
			provider: 'jira_oauth',
			encrypted_access_token: 'aes256gcm:access-deadbeef',
			encrypted_refresh_token: 'aes256gcm:refresh-cafebabe',
			expires_at: '2026-08-01T00:00:00.000Z',
			token_type: 'Bearer',
			scope: 'read:jira-work offline_access',
		});

		expect(result).toEqual(token);
		expect(result.status).toBe('active');
		expect(result.expires_at).toBe('2026-08-01T00:00:00.000Z');
		expect(result.encrypted_refresh_token).toBe('aes256gcm:refresh-cafebabe');
		expect(result.scope).toBe('read:jira-work offline_access');
	});

	it('upsertToken allows null refresh_token for auth-code-only flows', async () => {
		const token = fakeToken({
			encrypted_refresh_token: null,
			expires_at: null,
		});
		stubFetch(() => Response.json([token], { status: 201 }));
		const store = tokenStore();

		const result = await store.upsertToken('usr_1', {
			provider: 'github_oauth',
			encrypted_access_token: 'aes256gcm:gh-access',
			encrypted_refresh_token: null,
		});

		expect(result.encrypted_refresh_token).toBeNull();
	});

	it('upsertToken overwrites an existing token for the same user+provider', async () => {
		const updated = fakeToken({ encrypted_access_token: 'aes256gcm:newvalue' });
		stubFetch(() => Response.json([updated], { status: 200 }));
		const store = tokenStore();

		const result = await store.upsertToken('usr_1', {
			provider: 'jira_oauth',
			encrypted_access_token: 'aes256gcm:newvalue',
		});

		expect(result.encrypted_access_token).toBe('aes256gcm:newvalue');
	});

	it('upsertToken accepts an explicit status and label', async () => {
		const token = fakeToken({ status: 'active', label: 'Production Jira' });
		stubFetch(() => Response.json([token], { status: 201 }));
		const store = tokenStore();

		const result = await store.upsertToken('usr_1', {
			provider: 'jira_oauth',
			encrypted_access_token: 'aes256gcm:beef',
			status: 'active',
			label: 'Production Jira',
		});

		expect(result.status).toBe('active');
		expect(result.label).toBe('Production Jira');
	});

	it('upsertToken throws on non-ok response', async () => {
		stubFetch(() => new Response(null, { status: 500 }));
		const store = tokenStore();
		await expect(
			store.upsertToken('usr_1', {
				provider: 'jira_oauth',
				encrypted_access_token: 'val',
			}),
		).rejects.toThrow('oauthTokenStorage.upsertToken failed: 500');
	});

	// -----------------------------------------------------------------------
	// getToken
	// -----------------------------------------------------------------------

	it('getToken returns the token when it exists', async () => {
		const token = fakeToken();
		stubFetch(() => Response.json([token], { status: 200 }));
		const store = tokenStore();

		const result = await store.getToken('usr_1', 'jira_oauth');
		expect(result).toEqual(token);
	});

	it('getToken returns null when no token exists', async () => {
		stubFetch(() => Response.json([], { status: 200 }));
		const store = tokenStore();

		const result = await store.getToken('usr_1', 'jira_oauth');
		expect(result).toBeNull();
	});

	it('getToken isolates per-user', async () => {
		const token = fakeToken({ user_id: 'usr_2' });
		stubFetch(() => Response.json([token], { status: 200 }));
		const store = tokenStore();

		const result = await store.getToken('usr_2', 'jira_oauth');
		expect(result?.user_id).toBe('usr_2');
	});

	// -----------------------------------------------------------------------
	// listTokens
	// -----------------------------------------------------------------------

	it('listTokens returns all tokens for a user', async () => {
		const tokens = [
			fakeToken({ provider: 'jira_oauth' }),
			fakeToken({ provider: 'gitlab_oauth', id: 'other-id' }),
		];
		stubFetch(() => Response.json(tokens, { status: 200 }));
		const store = tokenStore();

		const result = await store.listTokens('usr_1');
		expect(result).toHaveLength(2);
		expect(result[0].provider).toBe('jira_oauth');
		expect(result[1].provider).toBe('gitlab_oauth');
	});

	it('listTokens returns an empty array for a user with no tokens', async () => {
		stubFetch(() => Response.json([], { status: 200 }));
		const store = tokenStore();

		const result = await store.listTokens('usr_1');
		expect(result).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// revokeToken
	// -----------------------------------------------------------------------

	it('revokeToken transitions an active token to revoked', async () => {
		const revoked = fakeToken({ status: 'revoked' });
		stubFetch(() => Response.json([revoked], { status: 200 }));
		const store = tokenStore();

		const result = await store.revokeToken('usr_1', 'jira_oauth');
		expect(result).not.toBeNull();
		expect(result!.status).toBe('revoked');
	});

	it('revokeToken returns null if no active token matched', async () => {
		stubFetch(() => Response.json([], { status: 200 }));
		const store = tokenStore();

		const result = await store.revokeToken('usr_1', 'jira_oauth');
		expect(result).toBeNull();
	});

	// -----------------------------------------------------------------------
	// deleteToken
	// -----------------------------------------------------------------------

	it('deleteToken returns true when a row was deleted', async () => {
		stubFetch(() => Response.json([fakeToken()], { status: 200 }));
		const store = tokenStore();

		const deleted = await store.deleteToken('usr_1', 'jira_oauth');
		expect(deleted).toBe(true);
	});

	it('deleteToken returns false when no row matched', async () => {
		stubFetch(() => Response.json([], { status: 200 }));
		const store = tokenStore();

		const deleted = await store.deleteToken('usr_1', 'jira_oauth');
		expect(deleted).toBe(false);
	});

	// -----------------------------------------------------------------------
	// Lifecycle integration: create → read → update (refresh) → revoke → delete
	// -----------------------------------------------------------------------

	it('full lifecycle: upsert → get → upsert (refresh) → revoke → delete', async () => {
		const db = new Map<string, OAuthToken>();

		function handler(input: RequestInfo, init?: RequestInit): Response {
			const url =
				typeof input === 'string'
					? input
					: input instanceof URL
						? input.toString()
						: String(input);

			const method = init?.method ?? 'GET';

			if (method === 'POST' && url.includes('/oauth_tokens')) {
				const body = JSON.parse(init?.body as string) as Record<
					string,
					unknown
				>;
				const token: OAuthToken = {
					id: crypto.randomUUID(),
					user_id: body.user_id as string,
					provider: body.provider as OAuthToken['provider'],
					label: (body.label as string) ?? null,
					encrypted_access_token: body.encrypted_access_token as string,
					encrypted_refresh_token:
						(body.encrypted_refresh_token as string) ?? null,
					expires_at: (body.expires_at as string) ?? null,
					token_type: (body.token_type as string) ?? null,
					scope: (body.scope as string) ?? null,
					status: (body.status as OAuthToken['status']) ?? 'active',
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				};
				const key = `${token.user_id}:${token.provider}`;
				db.set(key, token);
				return Response.json([token], { status: 201 });
			}

			if (method === 'PATCH' && url.includes('/oauth_tokens')) {
				const body = JSON.parse(init?.body as string) as Record<
					string,
					unknown
				>;
				const qs = url.split('?')[1] ?? '';
				const userIdMatch = qs.match(/user_id=eq\.([^&]+)/);
				const provMatch = qs.match(/provider=eq\.([^&]+)/);
				if (!userIdMatch || !provMatch)
					return Response.json([], { status: 200 });
				const key = `${userIdMatch[1]}:${provMatch[1]}`;
				const existing = db.get(key);
				if (!existing) return Response.json([], { status: 200 });
				// Status filter
				const statusFilter = qs.match(/status=eq\.([^&]+)/);
				if (statusFilter && existing.status !== statusFilter[1]) {
					return Response.json([], { status: 200 });
				}
				const updated: OAuthToken = {
					...existing,
					...body,
					updated_at: new Date().toISOString(),
				} as OAuthToken;
				db.set(key, updated);
				return Response.json([updated], { status: 200 });
			}

			if (method === 'DELETE' && url.includes('/oauth_tokens')) {
				const qs = url.split('?')[1] ?? '';
				const userIdMatch = qs.match(/user_id=eq\.([^&]+)/);
				const provMatch = qs.match(/provider=eq\.([^&]+)/);
				if (!userIdMatch || !provMatch)
					return Response.json([], { status: 200 });
				const key = `${userIdMatch[1]}:${provMatch[1]}`;
				const existing = db.get(key);
				if (existing) {
					db.delete(key);
					return Response.json([existing], { status: 200 });
				}
				return Response.json([], { status: 200 });
			}

			// GET — list or single
			if (method === 'GET' && url.includes('/oauth_tokens')) {
				const qs = url.split('?')[1] ?? '';
				const userIdMatch = qs.match(/user_id=eq\.([^&]+)/);
				const provMatch = qs.match(/provider=eq\.([^&]+)/);
				const results: OAuthToken[] = [];
				for (const t of db.values()) {
					if (
						(!userIdMatch || t.user_id === userIdMatch[1]) &&
						(!provMatch || t.provider === provMatch[1])
					) {
						results.push(t);
					}
				}
				return Response.json(results, { status: 200 });
			}

			return Response.json([], { status: 200 });
		}

		stubFetch(handler);
		const store = tokenStore();

		// 1. Create
		const created = await store.upsertToken('usr_1', {
			provider: 'gitlab_oauth',
			encrypted_access_token: 'aes256gcm:v1',
			encrypted_refresh_token: 'aes256gcm:r1',
			expires_at: '2026-08-01T00:00:00.000Z',
			label: 'Work GitLab',
		});
		expect(created.status).toBe('active');
		expect(created.label).toBe('Work GitLab');
		expect(created.expires_at).toBe('2026-08-01T00:00:00.000Z');

		// 2. Read back
		const got = await store.getToken('usr_1', 'gitlab_oauth');
		expect(got).not.toBeNull();
		expect(got!.encrypted_access_token).toBe('aes256gcm:v1');
		expect(got!.encrypted_refresh_token).toBe('aes256gcm:r1');

		// 3. Refresh (re-encrypt with new tokens)
		const refreshed = await store.upsertToken('usr_1', {
			provider: 'gitlab_oauth',
			encrypted_access_token: 'aes256gcm:v2',
			encrypted_refresh_token: 'aes256gcm:r2',
			expires_at: '2026-08-02T00:00:00.000Z',
		});
		expect(refreshed.encrypted_access_token).toBe('aes256gcm:v2');
		expect(refreshed.encrypted_refresh_token).toBe('aes256gcm:r2');

		// 4. Revoke
		const revoked = await store.revokeToken('usr_1', 'gitlab_oauth');
		expect(revoked!.status).toBe('revoked');

		// 5. Delete
		const deleted = await store.deleteToken('usr_1', 'gitlab_oauth');
		expect(deleted).toBe(true);

		// 6. Confirm gone
		const gone = await store.getToken('usr_1', 'gitlab_oauth');
		expect(gone).toBeNull();
	});

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	it('makeOAuthTokenStorage throws when SUPABASE_URL is missing', () => {
		expect(() =>
			makeOAuthTokenStorage({
				SUPABASE_SERVICE_ROLE_KEY: 'k',
			}),
		).toThrow('SUPABASE_URL');
	});

	it('makeOAuthTokenStorage throws when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
		expect(() =>
			makeOAuthTokenStorage({
				SUPABASE_URL: 'http://localhost',
			}),
		).toThrow('SUPABASE_SERVICE_ROLE_KEY');
	});

	it('listTokens throws on non-ok response', async () => {
		stubFetch(() => new Response(null, { status: 502 }));
		const store = tokenStore();
		await expect(store.listTokens('usr_1')).rejects.toThrow(
			'oauthTokenStorage.listTokens failed: 502',
		);
	});

	it('revokeToken throws on non-ok response', async () => {
		stubFetch(() => new Response(null, { status: 500 }));
		const store = tokenStore();
		await expect(store.revokeToken('usr_1', 'jira_oauth')).rejects.toThrow(
			'oauthTokenStorage.revokeToken failed: 500',
		);
	});

	it('deleteToken throws on non-ok response', async () => {
		stubFetch(() => new Response(null, { status: 500 }));
		const store = tokenStore();
		await expect(store.deleteToken('usr_1', 'jira_oauth')).rejects.toThrow(
			'oauthTokenStorage.deleteToken failed: 500',
		);
	});
});
