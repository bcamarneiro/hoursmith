/**
 * Initiate Git OAuth flow with GitHub (ADA-611).
 *
 * `GET /api/git-oauth/authorize?redirect=<app-redirect-url>`
 *
 * Generates a signed state parameter (CSRF protection), builds the GitHub OAuth
 * authorize URL, and redirects the user there.
 *
 * No authentication required — this is the entry point for the OAuth dance.
 * The user must be redirected back through /api/git-oauth/callback after
 * authorizing the GitHub App.
 *
 * Edge-runtime compatible.
 *
 * Linear: ADA-611.
 */

import {
	buildAuthorizeUrl,
	createState,
	resolveRedirectUri,
	type GitOAuthEnv,
} from '../_lib/gitOAuth.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface AuthorizeDeps {
	/** Environment overrides (tests). Defaults to `process.env`. */
	env?: GitOAuthEnv;
	/** Override "now" in ms (tests). */
	nowMs?: number;
}

export default async function handler(request: Request): Promise<Response> {
	return handleAuthorize(request);
}

export async function handleAuthorize(
	request: Request,
	deps: AuthorizeDeps = {},
): Promise<Response> {
	const env = deps.env ?? (process.env as GitOAuthEnv);

	// Only GET is allowed.
	if (request.method !== 'GET') {
		return new Response(
			JSON.stringify({ error: 'method_not_allowed' }),
			{
				status: 405,
				headers: { 'content-type': 'application/json' },
			},
		);
	}

	const url = new URL(request.url);
	const redirectUrl = url.searchParams.get('redirect');

	// Validate the redirect URL: must be provided and must not be open redirect.
	if (!redirectUrl) {
		return new Response(
			JSON.stringify({ error: 'missing_redirect' }),
			{
				status: 400,
				headers: { 'content-type': 'application/json' },
			},
		);
	}

	try {
		// The redirect must be a valid URL with an http/https scheme.
		const parsed = new URL(redirectUrl);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return new Response(
				JSON.stringify({ error: 'invalid_redirect_scheme' }),
				{
					status: 400,
					headers: { 'content-type': 'application/json' },
				},
			);
		}
	} catch {
		return new Response(
			JSON.stringify({ error: 'invalid_redirect' }),
			{
				status: 400,
				headers: { 'content-type': 'application/json' },
			},
		);
	}

	const secret = env.GIT_OAUTH_SECRET;
	const clientId = env.GIT_OAUTH_CLIENT_ID;

	if (!secret || !clientId) {
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				svc: 'hoursmith-git-oauth-authorize',
				code: 'server_misconfigured',
				status: 500,
			}),
		);
		return new Response(
			JSON.stringify({ error: 'server_misconfigured' }),
			{
				status: 500,
				headers: { 'content-type': 'application/json' },
			},
		);
	}

	let redirectUri: string;
	try {
		redirectUri = resolveRedirectUri(env);
	} catch {
		return new Response(
			JSON.stringify({ error: 'server_misconfigured' }),
			{
				status: 500,
				headers: { 'content-type': 'application/json' },
			},
		);
	}

	let state: string;
	try {
		state = await createState(redirectUrl, secret, deps.nowMs);
	} catch (err) {
		console.log(
			JSON.stringify({
				ts: new Date().toISOString(),
				svc: 'hoursmith-git-oauth-authorize',
				code: 'state_creation_failed',
				status: 500,
				detail: (err as Error).message,
			}),
		);
		return new Response(
			JSON.stringify({ error: 'state_creation_failed' }),
			{
				status: 500,
				headers: { 'content-type': 'application/json' },
			},
		);
	}

	const authorizeUrl = buildAuthorizeUrl(clientId, state, redirectUri);

	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-git-oauth-authorize',
			code: 'ok',
			status: 302,
		}),
	);

	return new Response(null, {
		status: 302,
		headers: { location: authorizeUrl },
	});
}
