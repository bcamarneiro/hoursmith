/**
 * Unit tests for `POST /api/oauth/refresh` (ADA-648).
 *
 * The exchange, cipher, storage, and JWT verifier are injected, so these run
 * with no network and no Supabase. The happy path uses a real (low-iteration)
 * `AesCipher` so we can decrypt the persisted value and assert the stored
 * bundle shape end-to-end.
 */

import { describe, expect, it, vi } from 'vitest';
import { AesCipher } from '../../_lib/aesCrypto.js';
import type { TokenStorage } from '../../_lib/tokenStorage.js';
import { OAuthExchangeError } from '../../_lib/oauthExchange.js';
import {
	handleRefresh,
	type RefreshDeps,
	type TokenCipher,
} from '../refresh.js';

const NOW = 1_750_000_000_000;
const HAPPY_EXCHANGE = {
	accessToken: 'fresh-access',
	refreshToken: 'rotated-refresh',
	expiresIn: 3600,
	scope: 'read:jira-user',
	tokenType: 'Bearer',
};

/**
 * Builds a `Request` for `handleRefresh`.
 *
 * happy-dom's Request constructor drops forbidden request headers (Origin,
 * Content-Length) per the Fetch spec, but a real edge runtime populates them
 * from the network layer. We carry them through a `headers.get` override so the
 * CORS (ADA-297) and body-size guards are exercised exactly as in production.
 */
function makeRequest(
	body: unknown,
	options: {
		method?: string;
		token?: string | null;
		origin?: string;
		contentLength?: number;
	} = {},
): Request {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (options.token !== null) {
		headers.set('authorization', `Bearer ${options.token ?? 'valid-token'}`);
	}
	const overrides = new Map<string, string>();
	if (options.origin) overrides.set('origin', options.origin);
	if (options.contentLength)
		overrides.set('content-length', String(options.contentLength));
	const method = options.method ?? 'POST';
	const isBodyless = method === 'GET' || method === 'HEAD';
	const base = new Request('https://hoursmith.io/api/oauth/refresh', {
		method,
		headers,
		...(isBodyless ? {} : { body: JSON.stringify(body) }),
	});
	return {
		method: base.method,
		headers: {
			get: (name: string) =>
				overrides.get(name.toLowerCase()) ?? base.headers.get(name),
		},
		json: () => base.json(),
	} as unknown as Request;
}

function fakeCipher(): TokenCipher & { encrypt: ReturnType<typeof vi.fn> } {
	return { encrypt: vi.fn(async (s: string) => `enc:${s}`) };
}

function fakeStorage(overrides: Partial<TokenStorage> = {}): TokenStorage & {
	upsertToken: ReturnType<typeof vi.fn>;
} {
	return {
		getToken: vi.fn(async () => null),
		upsertToken: vi.fn(async () => ({
			id: 't1',
			user_id: 'user-1',
			provider: 'jira_api',
			label: null,
			encrypted_value: '',
			status: 'active',
			created_at: '2026-01-01T00:00:00Z',
			updated_at: '2026-01-01T00:00:00Z',
			last_used_at: null,
		})),
		listTokens: vi.fn(async () => []),
		revokeToken: vi.fn(async () => null),
		deleteToken: vi.fn(async () => true),
		bumpLastUsed: vi.fn(async () => undefined),
		...overrides,
	} as unknown as TokenStorage & { upsertToken: ReturnType<typeof vi.fn> };
}

function makeDeps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
	return {
		verifyJwt: vi.fn(async () => 'user-1'),
		exchange: vi.fn(async () => HAPPY_EXCHANGE),
		cipher: fakeCipher(),
		storage: fakeStorage(),
		nowMs: NOW,
		...overrides,
	};
}

describe('POST /api/oauth/refresh', () => {
	it('answers OPTIONS preflight with CORS headers', async () => {
		const res = await handleRefresh(
			makeRequest(null, { method: 'OPTIONS', origin: 'https://hoursmith.io' }),
			makeDeps(),
		);
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe(
			'https://hoursmith.io',
		);
	});

	it('rejects non-POST methods', async () => {
		const res = await handleRefresh(
			makeRequest(null, { method: 'GET', token: null }),
			makeDeps(),
		);
		expect(res.status).toBe(405);
	});

	it('returns 401 when the Authorization header is missing', async () => {
		const deps = makeDeps();
		const res = await handleRefresh(
			makeRequest(
				{ provider: 'jira_api', refresh_token: 'r' },
				{ token: null },
			),
			deps,
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'missing_token' });
		expect(deps.exchange).not.toHaveBeenCalled();
	});

	it('returns 401 when the JWT is invalid', async () => {
		const deps = makeDeps({ verifyJwt: vi.fn(async () => null) });
		const res = await handleRefresh(
			makeRequest({ provider: 'jira_api', refresh_token: 'r' }),
			deps,
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'invalid_token' });
		expect(deps.exchange).not.toHaveBeenCalled();
	});

	it('returns 500 server_misconfigured when encryption env is missing', async () => {
		const deps = makeDeps({
			cipher: undefined,
			storage: undefined,
			env: { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y' },
		});
		const res = await handleRefresh(
			makeRequest({ provider: 'jira_api', refresh_token: 'r' }),
			deps,
		);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'server_misconfigured' });
	});

	it('rejects a body that is not a JSON object', async () => {
		for (const body of [null, 'jira_api', [1, 2]]) {
			const res = await handleRefresh(makeRequest(body), makeDeps());
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'invalid_body' });
		}
	});

	it('rejects unsupported providers', async () => {
		const deps = makeDeps();
		const res = await handleRefresh(
			makeRequest({ provider: 'rescuetime', refresh_token: 'r' }),
			deps,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'unsupported_provider' });
		expect(deps.exchange).not.toHaveBeenCalled();
	});

	it('rejects missing, empty, or oversized refresh tokens', async () => {
		const deps = makeDeps();
		for (const refreshToken of [undefined, '', 'x'.repeat(5000)]) {
			const res = await handleRefresh(
				makeRequest({ provider: 'jira_api', refresh_token: refreshToken }),
				deps,
			);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'invalid_refresh_token' });
		}
		expect(deps.exchange).not.toHaveBeenCalled();
	});

	it('rejects oversized bodies up front', async () => {
		const deps = makeDeps();
		const res = await handleRefresh(
			makeRequest(
				{ provider: 'jira_api', refresh_token: 'r', padding: 'x'.repeat(100) },
				{ contentLength: 20 * 1024 },
			),
			deps,
		);
		expect(res.status).toBe(413);
		expect(deps.exchange).not.toHaveBeenCalled();
	});

	it('refreshes, encrypts, stores, and reports success without leaking tokens', async () => {
		const cipher = new AesCipher('test-secret', { iterations: 100 });
		const storage = fakeStorage();
		const exchange = vi.fn(async () => HAPPY_EXCHANGE);
		const res = await handleRefresh(
			makeRequest(
				{ provider: 'jira_api', refresh_token: 'old-refresh' },
				{ origin: 'https://hoursmith.io' },
			),
			makeDeps({ cipher, storage, exchange }),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBe(
			'https://hoursmith.io',
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.provider).toBe('jira_api');
		expect(body.token_type).toBe('Bearer');
		expect(body.scope).toBe('read:jira-user');
		expect(body.expires_in).toBe(3600);
		// No tokens in the response, ever.
		expect(JSON.stringify(body)).not.toContain('fresh-access');
		expect(JSON.stringify(body)).not.toContain('old-refresh');

		expect(exchange).toHaveBeenCalledWith({
			provider: 'jira_api',
			refreshToken: 'old-refresh',
		});
		expect(storage.upsertToken).toHaveBeenCalledWith('user-1', {
			provider: 'jira_api',
			encrypted_value: expect.stringMatching(/^aes256gcm:/),
			status: 'active',
		});

		// The persisted value is the encrypted bundle — decrypt and verify.
		const stored = vi.mocked(storage.upsertToken).mock.calls[0][1]
			.encrypted_value as string;
		const bundle = JSON.parse(await cipher.decrypt(stored)) as {
			version: number;
			provider: string;
			accessToken: string;
			refreshToken: string;
			expiresAt: string;
			scope: string;
			tokenType: string;
		};
		expect(bundle).toEqual({
			version: 1,
			provider: 'jira_api',
			accessToken: 'fresh-access',
			refreshToken: 'rotated-refresh',
			expiresAt: new Date(NOW + 3600 * 1000).toISOString(),
			scope: 'read:jira-user',
			tokenType: 'Bearer',
		});
	});

	it('maps invalid_grant to 400 invalid_refresh_token and skips storage', async () => {
		const storage = fakeStorage();
		const deps = makeDeps({
			exchange: vi.fn(async () => {
				throw new OAuthExchangeError('invalid_grant', 'expired', 400);
			}),
			storage,
		});
		const res = await handleRefresh(
			makeRequest({ provider: 'jira_api', refresh_token: 'dead' }),
			deps,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_refresh_token' });
		expect(storage.upsertToken).not.toHaveBeenCalled();
	});

	it('maps upstream errors to 502', async () => {
		const deps = makeDeps({
			exchange: vi.fn(async () => {
				throw new OAuthExchangeError('upstream_error', 'boom', 500);
			}),
		});
		const res = await handleRefresh(
			makeRequest({ provider: 'jira_api', refresh_token: 'r' }),
			deps,
		);
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'upstream_error' });
	});

	it('maps upstream timeouts to 504', async () => {
		const deps = makeDeps({
			exchange: vi.fn(async () => {
				throw new OAuthExchangeError('upstream_timeout', 'slow', null);
			}),
		});
		const res = await handleRefresh(
			makeRequest({ provider: 'jira_api', refresh_token: 'r' }),
			deps,
		);
		expect(res.status).toBe(504);
		expect(await res.json()).toEqual({ error: 'upstream_timeout' });
	});

	it('maps invalid_client and server_misconfigured to 500', async () => {
		for (const code of ['invalid_client', 'server_misconfigured'] as const) {
			const deps = makeDeps({
				exchange: vi.fn(async () => {
					throw new OAuthExchangeError(code, 'env', null);
				}),
			});
			const res = await handleRefresh(
				makeRequest({ provider: 'jira_api', refresh_token: 'r' }),
				deps,
			);
			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({ error: 'server_misconfigured' });
		}
	});

	it('returns 502 exchange_failed on unexpected exchange errors', async () => {
		const deps = makeDeps({
			exchange: vi.fn(async () => {
				throw new Error('network exploded');
			}),
		});
		const res = await handleRefresh(
			makeRequest({ provider: 'jira_api', refresh_token: 'r' }),
			deps,
		);
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'exchange_failed' });
	});

	it('returns 500 token_refresh_failed when storage write fails', async () => {
		const storage = fakeStorage({
			upsertToken: vi.fn(async () => {
				throw new Error('supabase down');
			}),
		});
		const deps = makeDeps({ storage });
		const res = await handleRefresh(
			makeRequest({ provider: 'jira_api', refresh_token: 'r' }),
			deps,
		);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'token_refresh_failed' });
	});

	it('omits CORS headers for disallowed origins', async () => {
		const res = await handleRefresh(
			makeRequest(
				{ provider: 'jira_api', refresh_token: 'r' },
				{ origin: 'https://evil.example' },
			),
			makeDeps(),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
	});
});
