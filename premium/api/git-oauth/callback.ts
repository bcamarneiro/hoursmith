/**
 * Git OAuth callback — exchange code for token, issue internal token (ADA-611).
 *
 * `GET /api/git-oauth/callback?code=<code>&state=<state>`
 *
 * GitHub redirects here after the user authorizes the app. The endpoint:
 *   1. Verifies the signed state parameter
 *   2. Exchanges the `code` for a GitHub access token
 *   3. Fetches the authenticated GitHub user info
 *   4. Creates an internal access token (encrypted GitHub token inside)
 *   5. Redirects to the stored app redirect URL with the internal token
 *
 * No authentication required — the OAuth exchange is unauthenticated by design.
 * The returned internal token authenticates subsequent /api/git-oauth/token calls.
 *
 * Edge-runtime compatible.
 *
 * Linear: ADA-611.
 */

import {
	createInternalToken,
	exchangeCodeForToken,
	getGitHubUser,
	resolveRedirectUri,
	verifyState,
	type GitOAuthEnv,
} from '../_lib/gitOAuth.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface CallbackDeps {
	/** Environment overrides (tests). Defaults to `process.env`. */
	env?: GitOAuthEnv;
	/** Override "now" in ms (tests). */
	nowMs?: number;
	/** Injectable fetch for GitHub API calls (tests). */
	fetchImpl?: typeof fetch;
}

export default async function handler(request: Request): Promise<Response> {
	return handleCallback(request);
}

export async function handleCallback(
	request: Request,
	deps: CallbackDeps = {},
): Promise<Response> {
	const env = deps.env ?? (process.env as GitOAuthEnv);
	const nowMs = deps.nowMs ?? Date.now();
	const fetchImpl = deps.fetchImpl ?? fetch;

	if (request.method !== 'GET') {
		return jsonError(405, 'method_not_allowed');
	}

	const url = new URL(request.url);
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');

	if (!code || !state) {
		return jsonError(400, 'missing_params');
	}

	const secret = env.GIT_OAUTH_SECRET;
	const clientId = env.GIT_OAUTH_CLIENT_ID;
	const clientSecret = env.GIT_OAUTH_CLIENT_SECRET;

	if (!secret || !clientId || !clientSecret) {
		logCallback(null, 'server_misconfigured', 500);
		return jsonError(500, 'server_misconfigured');
	}

	// 1. Verify the signed state parameter and recover the original redirect URL.
	let redirectUrl: string | null;
	try {
		redirectUrl = await verifyState(state, secret, nowMs);
	} catch {
		redirectUrl = null;
	}

	if (!redirectUrl) {
		logCallback(null, 'invalid_state', 400);
		return jsonError(400, 'invalid_state');
	}

	// 2. Resolve the redirect URI that was used in the authorize step.
	let redirectUri: string;
	try {
		redirectUri = resolveRedirectUri(env);
	} catch {
		logCallback(null, 'server_misconfigured', 500);
		return jsonError(500, 'server_misconfigured');
	}

	// 3. Exchange the authorization code for a GitHub access token.
	let tokenResponse: { access_token: string };
	try {
		tokenResponse = await exchangeCodeForToken(
			code,
			clientId,
			clientSecret,
			redirectUri,
			fetchImpl,
		);
	} catch (err) {
		logCallback(null, 'token_exchange_failed', 502, (err as Error).message);
		return jsonError(502, 'token_exchange_failed');
	}

	// 4. Fetch the authenticated GitHub user.
	const accessToken = tokenResponse.access_token;
	let githubUser: { id: number; login: string };
	try {
		githubUser = await getGitHubUser(accessToken, fetchImpl);
	} catch (err) {
		logCallback(null, 'user_fetch_failed', 502, (err as Error).message);
		return jsonError(502, 'token_exchange_failed');
	}

	// 5. Create the internal access token carrying the encrypted GitHub token.
	let internalToken: string;
	try {
		internalToken = await createInternalToken(
			accessToken,
			githubUser,
			secret,
			nowMs,
		);
	} catch {
		logCallback(githubUser.id, 'internal_token_failed', 500);
		return jsonError(500, 'internal_token_failed');
	}

	logCallback(githubUser.id, 'ok', 302);

	// 6. Redirect back to the app with the internal token as a hash fragment.
	const finalUrl = new URL(redirectUrl);
	finalUrl.hash = `access_token=${encodeURIComponent(internalToken)}&token_type=bearer&state=${encodeURIComponent(state)}`;

	return new Response(null, {
		status: 302,
		headers: { location: finalUrl.toString() },
	});
}

function jsonError(status: number, error: string): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function logCallback(
	githubUserId: number | null,
	code: string,
	status: number,
	detail?: string,
): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-git-oauth-callback',
			github_user_id: githubUserId,
			code,
			status,
			...(detail ? { detail } : {}),
		}),
	);
}
