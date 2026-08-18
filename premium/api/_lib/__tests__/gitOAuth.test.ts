/**
 * Behaviour contract for the Git OAuth strategy & token exchange (ADA-611).
 *
 * Tests the core library functions — state signing/verification, token
 * exchange, internal token round-trip, and URL helpers. Endpoint integration
 * (authorize/callback/token handlers) is tested separately.
 *
 * All crypto operations use WebCrypto (available in happy-dom via vitest's
 * jsdom/happy-dom with webcrypto polyfill or native Node.js WebCrypto).
 *
 * Linear: ADA-611.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
	buildAuthorizeUrl,
	createInternalToken,
	createState,
	exchangeCodeForToken,
	getGitHubUser,
	resolveRedirectUri,
	verifyInternalToken,
	verifyState,
	type GitHubTokenResponse,
} from '../gitOAuth.js';
import { handleAuthorize } from '../../git-oauth/authorize.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

/** Test secret: at least 32 bytes for HMAC-SHA-256. */
const TEST_SECRET = 'test-secret-thats-at-least-32-bytes-long!!';

/** Fixed "now" so time-based tests are deterministic. */
const BASE_NOW = 1_700_000_000_000;

const TEST_CLIENT_ID = 'Iv1.test_client';
const TEST_CLIENT_SECRET = 'test_secret_abc123';

/** Environment vars that resolve redirect URI to the default (no override). */
const DEFAULT_ENV = {
	GIT_OAUTH_SECRET: TEST_SECRET,
	GIT_OAUTH_CLIENT_ID: TEST_CLIENT_ID,
	GIT_OAUTH_CLIENT_SECRET: TEST_CLIENT_SECRET,
	APP_URL: 'https://hoursmith.io',
};

/** Fake GitHub token that works with the mock fetch. */
const FAKE_GITHUB_TOKEN = 'gho_fake_token_abc123';

// ─── Mock GitHub API helpers ─────────────────────────────────────────────

/**
 * Create a fetch mock that behaves like GitHub's OAuth token endpoint.
 * First call (token exchange) returns the fake token; second call (user) returns
 * the GitHub user profile. Any unexpected URL returns 500.
 */
function mockGitHubFetch(
	options: {
		tokenResponse?: Partial<GitHubTokenResponse>;
		userResponse?: Record<string, unknown>;
		tokenStatusCode?: number;
		userStatusCode?: number;
	} = {},
): typeof fetch {
	const {
		tokenResponse = {},
		userResponse = {},
		tokenStatusCode = 200,
		userStatusCode = 200,
	} = options;

	const buildTokenBody = () => {
		const body = { ...tokenResponse };
		// Only inject defaults when the caller didn't explicitly pass the key.
		// A test can pass `access_token: undefined` to suppress the default.
		if (!('access_token' in tokenResponse)) {
			body.access_token = FAKE_GITHUB_TOKEN;
		}
		if (!('token_type' in tokenResponse)) {
			body.token_type = 'bearer';
		}
		if (!('scope' in tokenResponse)) {
			body.scope = 'repo';
		}
		return JSON.stringify(body);
	};

	const buildUserBody = () => {
		const body = { ...userResponse };
		if (!('id' in userResponse)) body.id = 12345;
		if (!('login' in userResponse)) body.login = 'testuser';
		if (!('avatar_url' in userResponse))
			body.avatar_url = 'https://avatars.githubusercontent.com/u/12345';
		if (!('name' in userResponse)) body.name = 'Test User';
		return JSON.stringify(body);
	};

	return ((input: string, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : input.url;

		if (url === 'https://github.com/login/oauth/access_token') {
			return Promise.resolve(
				new Response(buildTokenBody(), {
					status: tokenStatusCode,
					headers: { 'content-type': 'application/json' },
				}),
			);
		}

		if (url === 'https://api.github.com/user') {
			return Promise.resolve(
				new Response(buildUserBody(), {
					status: userStatusCode,
					headers: { 'content-type': 'application/json' },
				}),
			);
		}

		return Promise.resolve(
			new Response(JSON.stringify({ error: 'unexpected_url' }), {
				status: 500,
			}),
		);
	}) as unknown as typeof fetch;
}

describe('createState / verifyState', () => {
	it('creates and verifies a valid state parameter', async () => {
		const state = await createState(
			'https://hoursmith.io/account',
			TEST_SECRET,
			BASE_NOW,
		);
		expect(state).toMatch(/^.+\..+$/); // two-part

		const redirect = await verifyState(
			state,
			TEST_SECRET,
			BASE_NOW,
		);
		expect(redirect).toBe('https://hoursmith.io/account');
	});

	it('returns null for an expired state parameter', async () => {
		const state = await createState(
			'https://hoursmith.io/account',
			TEST_SECRET,
			BASE_NOW,
		);
		// Advance time past the 5-minute TTL.
		const expired = BASE_NOW + 5 * 60 * 1000 + 1000;
		const redirect = await verifyState(state, TEST_SECRET, expired);
		expect(redirect).toBeNull();
	});

	it('returns null for a tampered state parameter', async () => {
		const state = await createState(
			'https://hoursmith.io/account',
			TEST_SECRET,
			BASE_NOW,
		);
		// Flip a bit in the payload portion.
		const tampered =
			state[0] === 'A' ? `B${state.slice(1)}` : `A${state.slice(1)}`;
		const redirect = await verifyState(tampered, TEST_SECRET, BASE_NOW);
		expect(redirect).toBeNull();
	});

	it('returns null for a malformed state string', async () => {
		const redirect = await verifyState('not-a-valid-state', TEST_SECRET, BASE_NOW);
		expect(redirect).toBeNull();
	});

	it('returns null for a state with the wrong secret', async () => {
		const state = await createState(
			'https://hoursmith.io/account',
			TEST_SECRET,
			BASE_NOW,
		);
		const redirect = await verifyState(
			state,
			'wrong-secret-that-is-also-long-enough-haha',
			BASE_NOW,
		);
		expect(redirect).toBeNull();
	});

	it('empty string returns null', async () => {
		const redirect = await verifyState('', TEST_SECRET, BASE_NOW);
		expect(redirect).toBeNull();
	});

	it('state with no dot separator returns null', async () => {
		const redirect = await verifyState('justbase64', TEST_SECRET, BASE_NOW);
		expect(redirect).toBeNull();
	});
});

describe('exchangeCodeForToken', () => {
	it('exchanges a valid code for a GitHub access token', async () => {
		const result = await exchangeCodeForToken(
			'valid_code',
			TEST_CLIENT_ID,
			TEST_CLIENT_SECRET,
			'https://hoursmith.io/api/git-oauth/callback',
			mockGitHubFetch(),
		);
		expect(result.access_token).toBe(FAKE_GITHUB_TOKEN);
		expect(result.token_type).toBe('bearer');
		expect(result.scope).toBe('repo');
	});

	it('throws on a non-ok HTTP response', async () => {
		const fetchImpl = mockGitHubFetch({ tokenStatusCode: 422 });
		await expect(
			exchangeCodeForToken(
				'bad_code',
				TEST_CLIENT_ID,
				TEST_CLIENT_SECRET,
				'https://hoursmith.io/api/git-oauth/callback',
				fetchImpl,
			),
		).rejects.toThrow(/GitHub token exchange failed/);
	});

	it('throws on a network error', async () => {
		const fetchImpl = (() =>
			Promise.reject(new Error('fetch failed'))) as unknown as typeof fetch;
		await expect(
			exchangeCodeForToken(
				'code',
				TEST_CLIENT_ID,
				TEST_CLIENT_SECRET,
				'https://hoursmith.io/api/git-oauth/callback',
				fetchImpl,
			),
		).rejects.toThrow(/network error/);
	});

	it('throws when the response has an error field', async () => {
		const fetchImpl = mockGitHubFetch({
			tokenResponse: {
				error: 'bad_verification_code',
				error_description: 'The code passed is incorrect or expired.',
			} as unknown as Partial<GitHubTokenResponse>,
		});
		await expect(
			exchangeCodeForToken(
				'expired_code',
				TEST_CLIENT_ID,
				TEST_CLIENT_SECRET,
				'https://hoursmith.io/api/git-oauth/callback',
				fetchImpl,
			),
		).rejects.toThrow(/bad_verification_code/);
	});

	it('throws when access_token is missing', async () => {
		const fetchImpl = mockGitHubFetch({
			tokenResponse: { access_token: undefined } as unknown as Partial<GitHubTokenResponse>,
		});
		await expect(
			exchangeCodeForToken(
				'code',
				TEST_CLIENT_ID,
				TEST_CLIENT_SECRET,
				'https://hoursmith.io/api/git-oauth/callback',
				fetchImpl,
			),
		).rejects.toThrow(/missing access_token/);
	});
});

describe('getGitHubUser', () => {
	it('fetches and returns the authenticated user profile', async () => {
		const user = await getGitHubUser(
			FAKE_GITHUB_TOKEN,
			mockGitHubFetch(),
		);
		expect(user.id).toBe(12345);
		expect(user.login).toBe('testuser');
		expect(user.name).toBe('Test User');
	});

	it('throws on a non-ok response', async () => {
		const fetchImpl = mockGitHubFetch({ userStatusCode: 401 });
		await expect(
			getGitHubUser('bad_token', fetchImpl),
		).rejects.toThrow(/GitHub user endpoint returned 401/);
	});

	it('throws on a network error', async () => {
		const fetchImpl = (() =>
			Promise.reject(new Error('network down'))) as unknown as typeof fetch;
		await expect(
			getGitHubUser('token', fetchImpl),
		).rejects.toThrow(/network error/);
	});

	it('throws when the response lacks an id', async () => {
		const fetchImpl = mockGitHubFetch({
			userResponse: { login: 'noid', id: undefined },
		});
		await expect(
			getGitHubUser('token', fetchImpl),
		).rejects.toThrow(/missing id/);
	});
});

describe('createInternalToken / verifyInternalToken', () => {
	it('creates and verifies a valid internal token', async () => {
		const token = await createInternalToken(
			FAKE_GITHUB_TOKEN,
			{ id: 12345, login: 'testuser' },
			TEST_SECRET,
			BASE_NOW,
		);
		expect(token).toMatch(/^.+\..+$/);

		const verified = await verifyInternalToken(token, TEST_SECRET, BASE_NOW);
		expect(verified).not.toBeNull();
		expect(verified!.githubUserId).toBe(12345);
		expect(verified!.githubLogin).toBe('testuser');
		expect(verified!.githubToken).toBe(FAKE_GITHUB_TOKEN);
	});

	it('returns null for an expired token', async () => {
		const token = await createInternalToken(
			FAKE_GITHUB_TOKEN,
			{ id: 12345, login: 'testuser' },
			TEST_SECRET,
			BASE_NOW,
		);
		// Past 15-minute TTL.
		const expired = BASE_NOW + 15 * 60 * 1000 + 1000;
		const verified = await verifyInternalToken(token, TEST_SECRET, expired);
		expect(verified).toBeNull();
	});

	it('returns null for a tampered token', async () => {
		const token = await createInternalToken(
			FAKE_GITHUB_TOKEN,
			{ id: 12345, login: 'testuser' },
			TEST_SECRET,
			BASE_NOW,
		);
		const tampered = token.slice(0, -1); // corrupt last char
		const verified = await verifyInternalToken(tampered, TEST_SECRET, BASE_NOW);
		expect(verified).toBeNull();
	});

	it('returns null for a malformed token string', async () => {
		const verified = await verifyInternalToken(
			'not-a-valid-token',
			TEST_SECRET,
			BASE_NOW,
		);
		expect(verified).toBeNull();
	});

	it('returns null with a different secret', async () => {
		const token = await createInternalToken(
			FAKE_GITHUB_TOKEN,
			{ id: 12345, login: 'testuser' },
			TEST_SECRET,
			BASE_NOW,
		);
		const verified = await verifyInternalToken(
			token,
			'different-secret-that-is-at-least-32-characters',
			BASE_NOW,
		);
		expect(verified).toBeNull();
	});

	it('round-trips special characters in the GitHub token', async () => {
		const specialToken = 'ghp_abc!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
		const token = await createInternalToken(
			specialToken,
			{ id: 1, login: 'special' },
			TEST_SECRET,
			BASE_NOW,
		);
		const verified = await verifyInternalToken(token, TEST_SECRET, BASE_NOW);
		expect(verified).not.toBeNull();
		expect(verified!.githubToken).toBe(specialToken);
	});
});

describe('resolveRedirectUri', () => {
	it('constructs the default redirect URI from APP_URL', () => {
		const uri = resolveRedirectUri({ APP_URL: 'https://hoursmith.io' });
		expect(uri).toBe('https://hoursmith.io/api/git-oauth/callback');
	});

	it('strips trailing slashes from APP_URL', () => {
		const uri = resolveRedirectUri({ APP_URL: 'https://hoursmith.io///' });
		expect(uri).toBe('https://hoursmith.io/api/git-oauth/callback');
	});

	it('uses GIT_OAUTH_REDIRECT_URI when set', () => {
		const uri = resolveRedirectUri({
			APP_URL: 'https://hoursmith.io',
			GIT_OAUTH_REDIRECT_URI: 'https://custom.example.com/cb',
		});
		expect(uri).toBe('https://custom.example.com/cb');
	});

	it('throws without APP_URL or GIT_OAUTH_REDIRECT_URI', () => {
		expect(() => resolveRedirectUri({})).toThrow('APP_URL');
	});
});

describe('buildAuthorizeUrl', () => {
	it('builds a valid GitHub OAuth authorize URL', () => {
		const url = buildAuthorizeUrl(
			TEST_CLIENT_ID,
			'test_state_value',
			'https://hoursmith.io/api/git-oauth/callback',
		);
		expect(url).toContain('https://github.com/login/oauth/authorize');
		expect(url).toContain(`client_id=${TEST_CLIENT_ID}`);
		expect(url).toContain('scope=repo');
		expect(url).toContain('state=test_state_value');
		expect(url).toContain('redirect_uri=https%3A%2F%2Fhoursmith.io%2Fapi%2Fgit-oauth%2Fcallback');
	});
});

describe('handleAuthorize open redirect', () => {
	it('rejects a redirect to an external host', async () => {
		const request = new Request(
			'https://hoursmith.io/api/git-oauth/authorize?redirect=https://evil.com/steal',
		);
		const response = await handleAuthorize(request, {
			env: {
				GIT_OAUTH_SECRET: TEST_SECRET,
				GIT_OAUTH_CLIENT_ID: TEST_CLIENT_ID,
				GIT_OAUTH_CLIENT_SECRET: TEST_CLIENT_SECRET,
				APP_URL: 'https://hoursmith.io',
			},
			nowMs: BASE_NOW,
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toBe('invalid_redirect_host');
	});

	it('allows a redirect to the same origin', async () => {
		const request = new Request(
			'https://hoursmith.io/api/git-oauth/authorize?redirect=https://hoursmith.io/settings/git',
		);
		const response = await handleAuthorize(request, {
			env: {
				GIT_OAUTH_SECRET: TEST_SECRET,
				GIT_OAUTH_CLIENT_ID: TEST_CLIENT_ID,
				GIT_OAUTH_CLIENT_SECRET: TEST_CLIENT_SECRET,
				APP_URL: 'https://hoursmith.io',
			},
			nowMs: BASE_NOW,
		});
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toContain('github.com/login/oauth/authorize');
	});
});
