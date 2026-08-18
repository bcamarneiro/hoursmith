/**
 * Tests for the OAuth2 refresh-token exchange library (ADA-648).
 *
 * The fetch is injected, so these run with no network. We assert the request
 * shape per provider, response normalization (including refresh-token
 * rotation fallback), the error taxonomy, and the stored-bundle helpers.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	buildTokenBundle,
	exchangeRefreshToken,
	isRefreshProvider,
	OAuthExchangeError,
	parseBundle,
	serializeBundle,
} from '../oauthExchange.js';

function okFetch(payload: Record<string, unknown>): typeof fetch {
	return vi.fn(async () => {
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}) as unknown as typeof fetch;
}

function errorFetch(status: number, payload: unknown): typeof fetch {
	return vi.fn(async () => {
		return new Response(JSON.stringify(payload), {
			status,
			headers: { 'content-type': 'application/json' },
		});
	}) as unknown as typeof fetch;
}

/** All client credentials present — the default happy-path env. */
function fullEnv() {
	return {
		JIRA_OAUTH_CLIENT_ID: 'jira-id',
		JIRA_OAUTH_CLIENT_SECRET: 'jira-secret',
		GITLAB_OAUTH_CLIENT_ID: 'gitlab-id',
		GITLAB_OAUTH_CLIENT_SECRET: 'gitlab-secret',
		GITHUB_OAUTH_CLIENT_ID: 'github-id',
		GITHUB_OAUTH_CLIENT_SECRET: 'github-secret',
	};
}

const INPUT = { provider: 'jira_api' as const, refreshToken: 'old-refresh' };

describe('isRefreshProvider', () => {
	it('accepts refresh-capable providers and rejects PAT-only ones', () => {
		expect(isRefreshProvider('jira_api')).toBe(true);
		expect(isRefreshProvider('gitlab')).toBe(true);
		expect(isRefreshProvider('github')).toBe(true);
		expect(isRefreshProvider('rescuetime')).toBe(false);
		expect(isRefreshProvider('')).toBe(false);
	});
});

describe('exchangeRefreshToken', () => {
	it('POSTs a refresh_token grant to the provider token endpoint', async () => {
		const fetchImpl = okFetch({
			access_token: 'new-access',
			refresh_token: 'new-refresh',
			expires_in: 3600,
			scope: 'read:jira-user',
			token_type: 'Bearer',
		});
		const result = await exchangeRefreshToken(INPUT, {
			env: fullEnv(),
			fetchImpl,
		});

		const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(url).toBe('https://auth.atlassian.com/oauth/token');
		expect(init.method).toBe('POST');
		expect(init.headers).toMatchObject({
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json',
		});
		const form = new URLSearchParams(init.body as string);
		expect(form.get('grant_type')).toBe('refresh_token');
		expect(form.get('client_id')).toBe('jira-id');
		expect(form.get('client_secret')).toBe('jira-secret');
		expect(form.get('refresh_token')).toBe('old-refresh');

		expect(result).toEqual({
			accessToken: 'new-access',
			refreshToken: 'new-refresh',
			expiresIn: 3600,
			scope: 'read:jira-user',
			tokenType: 'Bearer',
		});
	});

	it('hits the GitLab and GitHub endpoints with their own credentials', async () => {
		const fetchImpl = okFetch({ access_token: 'a' });
		await exchangeRefreshToken(
			{ provider: 'gitlab', refreshToken: 'r' },
			{ env: fullEnv(), fetchImpl },
		);
		expect(
			(vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit])[0],
		).toBe('https://gitlab.com/oauth/token');
		expect(
			new URLSearchParams(
				(vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit])[1]
					.body as string,
			).get('client_id'),
		).toBe('gitlab-id');

		const fetchImpl2 = okFetch({ access_token: 'a' });
		await exchangeRefreshToken(
			{ provider: 'github', refreshToken: 'r' },
			{ env: fullEnv(), fetchImpl: fetchImpl2 },
		);
		expect(
			(vi.mocked(fetchImpl2).mock.calls[0] as [string, RequestInit])[0],
		).toBe('https://github.com/login/oauth/access_token');
		expect(
			new URLSearchParams(
				(vi.mocked(fetchImpl2).mock.calls[0] as [string, RequestInit])[1]
					.body as string,
			).get('client_id'),
		).toBe('github-id');
	});

	it('keeps the input refresh token when the provider does not rotate it', async () => {
		const fetchImpl = okFetch({ access_token: 'new-access' });
		const result = await exchangeRefreshToken(INPUT, {
			env: fullEnv(),
			fetchImpl,
		});
		expect(result.refreshToken).toBe('old-refresh');
	});

	it('normalizes missing optional fields to null', async () => {
		const fetchImpl = okFetch({ access_token: 'new-access' });
		const result = await exchangeRefreshToken(INPUT, {
			env: fullEnv(),
			fetchImpl,
		});
		expect(result.expiresIn).toBeNull();
		expect(result.scope).toBeNull();
		expect(result.tokenType).toBeNull();
	});

	it('throws server_misconfigured when client credentials are missing', async () => {
		const fetchImpl = okFetch({ access_token: 'a' });
		const err = await exchangeRefreshToken(INPUT, {
			env: {},
			fetchImpl,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OAuthExchangeError);
		expect((err as OAuthExchangeError).code).toBe('server_misconfigured');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('maps upstream invalid_grant to the invalid_grant code', async () => {
		const fetchImpl = errorFetch(400, {
			error: 'invalid_grant',
			error_description: 'The refresh token is expired or revoked.',
		});
		const err = await exchangeRefreshToken(INPUT, {
			env: fullEnv(),
			fetchImpl,
		}).catch((e: unknown) => e);
		expect((err as OAuthExchangeError).code).toBe('invalid_grant');
		expect((err as OAuthExchangeError).upstreamStatus).toBe(400);
	});

	it('maps upstream invalid_client to the invalid_client code', async () => {
		const fetchImpl = errorFetch(401, { error: 'invalid_client' });
		const err = await exchangeRefreshToken(INPUT, {
			env: fullEnv(),
			fetchImpl,
		}).catch((e: unknown) => e);
		expect((err as OAuthExchangeError).code).toBe('invalid_client');
	});

	it('maps unrecognized upstream errors to upstream_error', async () => {
		const fetchImpl = errorFetch(502, { message: 'gateway blew up' });
		const err = await exchangeRefreshToken(INPUT, {
			env: fullEnv(),
			fetchImpl,
		}).catch((e: unknown) => e);
		expect((err as OAuthExchangeError).code).toBe('upstream_error');
		expect((err as OAuthExchangeError).upstreamStatus).toBe(502);
	});

	it('treats a non-JSON error payload as upstream_error', async () => {
		const fetchImpl = vi.fn(async () => {
			return new Response('<html>nope</html>', { status: 502 });
		}) as unknown as typeof fetch;
		const err = await exchangeRefreshToken(INPUT, {
			env: fullEnv(),
			fetchImpl,
		}).catch((e: unknown) => e);
		expect((err as OAuthExchangeError).code).toBe('upstream_error');
	});

	it('treats a malformed success payload as upstream_error', async () => {
		const fetchImpl = okFetch({ token: 'not-access-token' });
		const err = await exchangeRefreshToken(INPUT, {
			env: fullEnv(),
			fetchImpl,
		}).catch((e: unknown) => e);
		expect((err as OAuthExchangeError).code).toBe('upstream_error');
	});

	it('aborts and reports upstream_timeout when the provider hangs', async () => {
		// The injected fetch only rejects when our timeout signal fires.
		const fetchImpl = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init.signal as AbortSignal;
					signal.addEventListener('abort', () => {
						reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
					});
				}),
		) as unknown as typeof fetch;
		const err = await exchangeRefreshToken(INPUT, {
			env: fullEnv(),
			fetchImpl,
			timeoutMs: 20,
		}).catch((e: unknown) => e);
		expect((err as OAuthExchangeError).code).toBe('upstream_timeout');
	});
});

describe('token bundle helpers', () => {
	const NOW = 1_750_000_000_000;

	it('builds an ISO expiry from expires_in seconds', () => {
		const bundle = buildTokenBundle(
			{
				accessToken: 'a',
				refreshToken: 'r',
				expiresIn: 3600,
				scope: 's',
				tokenType: 'Bearer',
			},
			'jira_api',
			NOW,
		);
		expect(bundle).toEqual({
			version: 1,
			provider: 'jira_api',
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: new Date(NOW + 3600 * 1000).toISOString(),
			scope: 's',
			tokenType: 'Bearer',
		});
	});

	it('stores a null expiry when the provider reports none', () => {
		const bundle = buildTokenBundle(
			{
				accessToken: 'a',
				refreshToken: 'r',
				expiresIn: null,
				scope: null,
				tokenType: null,
			},
			'github',
			NOW,
		);
		expect(bundle.expiresAt).toBeNull();
	});

	it('round-trips through serialize/parse', () => {
		const bundle = buildTokenBundle(
			{
				accessToken: 'a',
				refreshToken: 'r',
				expiresIn: 60,
				scope: null,
				tokenType: null,
			},
			'gitlab',
			NOW,
		);
		expect(parseBundle(serializeBundle(bundle))).toEqual(bundle);
	});

	it('rejects malformed or unknown-version payloads', () => {
		expect(() => parseBundle('not json')).toThrow();
		expect(() => parseBundle(JSON.stringify({ version: 99 }))).toThrow();
		expect(() =>
			parseBundle(
				JSON.stringify({
					version: 1,
					provider: 'rescuetime',
					accessToken: 'a',
					refreshToken: 'r',
				}),
			),
		).toThrow();
	});
});
