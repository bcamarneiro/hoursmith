/**
 * Unit tests for `POST / GET / DELETE /api/providerConfig/tokens`.
 *
 * Linear: ADA-271, ADA-523.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin.js';
import type { TokenStorage, UserToken } from '../../_lib/tokenStorage.js';
import { handleTokens } from '../tokens.js';

// ── Helpers ──

function makeRequest(
	method: string,
	headers: Record<string, string> = {},
	body?: unknown,
): Request {
	return new Request(
		'https://hoursmith.io/api/providerConfig/tokens',
		{
			method,
			headers: { 'content-type': 'application/json', ...headers },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		},
	);
}

function makeAdmin(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		getUserIdFromToken: vi.fn().mockResolvedValue('user-123'),
		getSubscription: vi.fn(),
		getProfile: vi.fn(),
		getSubscriptionByCustomerId: vi.fn(),
		insertIncompleteSubscription: vi.fn(),
		upsertSubscription: vi.fn(),
		deleteSubscription: vi.fn(),
		deleteProfile: vi.fn(),
		deleteAuthUser: vi.fn(),
		signOutUser: vi.fn().mockResolvedValue(undefined),
		insertAuditLog: vi.fn(),
		recordBillingEvent: vi.fn().mockResolvedValue(true),
		...overrides,
	};
}

function makeTokenStore(overrides: Partial<TokenStorage> = {}): TokenStorage {
	return {
		upsertToken: vi.fn().mockResolvedValue(fakeToken()),
		listTokens: vi.fn().mockResolvedValue([]),
		getToken: vi.fn().mockResolvedValue(null),
		revokeToken: vi.fn().mockResolvedValue(null),
		deleteToken: vi.fn().mockResolvedValue(false),
		bumpLastUsed: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function fakeToken(overrides: Partial<UserToken> = {}): UserToken {
	return {
		id: 'tok-1',
		user_id: 'user-123',
		provider: 'jira_api',
		label: 'Work Jira',
		encrypted_value: 'aes256gcm:abc123',
		status: 'active',
		created_at: '2026-07-28T00:00:00.000Z',
		updated_at: '2026-07-28T00:00:00.000Z',
		last_used_at: null,
		...overrides,
	};
}

// ── Auth gate ──

describe('GET /api/providerConfig/tokens', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const res = await handleTokens(makeRequest('GET'), {
			admin: makeAdmin(),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe('missing_token');
	});

	it('returns 401 when JWT is invalid', async () => {
		const admin = makeAdmin({
			getUserIdFromToken: vi.fn().mockResolvedValue(null),
		});
		const res = await handleTokens(
			makeRequest('GET', { authorization: 'Bearer bad' }),
			{ admin },
		);
		expect(res.status).toBe(401);
	});

	it('lists tokens for the authenticated user', async () => {
		const token = fakeToken();
		const store = makeTokenStore({
			listTokens: vi.fn().mockResolvedValue([token]),
		});
		const res = await handleTokens(
			makeRequest('GET', { authorization: 'Bearer ok' }),
			{ admin: makeAdmin(), tokens: store },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			tokens: Array<Record<string, unknown>>;
		};
		expect(body.tokens).toHaveLength(1);
		expect(body.tokens[0].provider).toBe('jira_api');
		expect(body.tokens[0].label).toBe('Work Jira');
		// Encrypted value must not leak.
		expect(body.tokens[0]).not.toHaveProperty('encrypted_value');
	});

	it('returns empty array when user has no tokens', async () => {
		const res = await handleTokens(
			makeRequest('GET', { authorization: 'Bearer ok' }),
			{ admin: makeAdmin(), tokens: makeTokenStore({ listTokens: vi.fn().mockResolvedValue([]) }) },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tokens: unknown[] };
		expect(body.tokens).toEqual([]);
	});
});

// ── Upsert ──

describe('POST /api/providerConfig/tokens', () => {
	it('creates a new token when none existed', async () => {
		const created = fakeToken({ provider: 'github', label: 'GitHub' });
		const store = makeTokenStore({
			upsertToken: vi.fn().mockResolvedValue(created),
		});
		const res = await handleTokens(
			makeRequest('POST', { authorization: 'Bearer ok' }, {
				provider: 'github',
				apiKey: 'ghp_abc123',
				label: 'GitHub',
			}),
			{ admin: makeAdmin(), tokens: store },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { token: Record<string, unknown> };
		expect(body.token.provider).toBe('github');
		expect(body.token.status).toBe('active');
		expect(body.token).not.toHaveProperty('encrypted_value');
	});

	it('rejects invalid providers', async () => {
		const res = await handleTokens(
			makeRequest('POST', { authorization: 'Bearer ok' }, {
				provider: 'unknown_svc',
				apiKey: 'abc123',
			}),
			{ admin: makeAdmin(), tokens: makeTokenStore() },
		);
		expect(res.status).toBe(400);
	});

	it('rejects missing apiKey', async () => {
		const res = await handleTokens(
			makeRequest('POST', { authorization: 'Bearer ok' }, {
				provider: 'jira_api',
			}),
			{ admin: makeAdmin(), tokens: makeTokenStore() },
		);
		expect(res.status).toBe(400);
	});

	it('rejects blank apiKey', async () => {
		const res = await handleTokens(
			makeRequest('POST', { authorization: 'Bearer ok' }, {
				provider: 'jira_api',
				apiKey: '   ',
			}),
			{ admin: makeAdmin(), tokens: makeTokenStore() },
		);
		expect(res.status).toBe(400);
	});

	it('rejects invalid JSON body', async () => {
		const req = new Request(
			'https://hoursmith.io/api/providerConfig/tokens',
			{
				method: 'POST',
				headers: {
					authorization: 'Bearer ok',
					'content-type': 'application/json',
				},
				body: 'not json',
			},
		);
		const res = await handleTokens(req, {
			admin: makeAdmin(),
			tokens: makeTokenStore(),
		});
		expect(res.status).toBe(400);
	});

	it('overwrites an existing token (upsert)', async () => {
		const updated = fakeToken({ encrypted_value: 'aes256gcm:newval' });
		const store = makeTokenStore({
			upsertToken: vi.fn().mockResolvedValue(updated),
		});
		const res = await handleTokens(
			makeRequest('POST', { authorization: 'Bearer ok' }, {
				provider: 'jira_api',
				apiKey: 'newkey',
			}),
			{ admin: makeAdmin(), tokens: store },
		);
		expect(res.status).toBe(200);
	});
});

// ── Delete ──

describe('DELETE /api/providerConfig/tokens', () => {
	it('deletes a token that exists', async () => {
		const store = makeTokenStore({
			deleteToken: vi.fn().mockResolvedValue(true),
		});
		const url = new URL('https://hoursmith.io/api/providerConfig/tokens');
		url.searchParams.set('provider', 'jira_api');
		const req = new Request(url.toString(), {
			method: 'DELETE',
			headers: { authorization: 'Bearer ok' },
		});
		const res = await handleTokens(req, {
			admin: makeAdmin(),
			tokens: store,
		});
		expect(res.status).toBe(200);
	});

	it('returns 404 when the token does not exist', async () => {
		const store = makeTokenStore({
			deleteToken: vi.fn().mockResolvedValue(false),
		});
		const url = new URL('https://hoursmith.io/api/providerConfig/tokens');
		url.searchParams.set('provider', 'jira_api');
		const req = new Request(url.toString(), {
			method: 'DELETE',
			headers: { authorization: 'Bearer ok' },
		});
		const res = await handleTokens(req, {
			admin: makeAdmin(),
			tokens: store,
		});
		expect(res.status).toBe(404);
	});

	it('rejects delete without provider param', async () => {
		const res = await handleTokens(
			makeRequest('DELETE', { authorization: 'Bearer ok' }),
			{ admin: makeAdmin(), tokens: makeTokenStore() },
		);
		expect(res.status).toBe(400);
	});

	it('rejects delete with invalid provider', async () => {
		const url = new URL('https://hoursmith.io/api/providerConfig/tokens');
		url.searchParams.set('provider', 'bogus');
		const req = new Request(url.toString(), {
			method: 'DELETE',
			headers: { authorization: 'Bearer ok' },
		});
		const res = await handleTokens(req, {
			admin: makeAdmin(),
			tokens: makeTokenStore(),
		});
		expect(res.status).toBe(400);
	});
});

// ── Method gate ──

describe('method gating', () => {
	it('rejects PUT', async () => {
		const res = await handleTokens(
			makeRequest('PUT', { authorization: 'Bearer ok' }),
			{ admin: makeAdmin() },
		);
		expect(res.status).toBe(405);
	});

	it('rejects PATCH', async () => {
		const res = await handleTokens(
			makeRequest('PATCH', { authorization: 'Bearer ok' }),
			{ admin: makeAdmin() },
		);
		expect(res.status).toBe(405);
	});
});
