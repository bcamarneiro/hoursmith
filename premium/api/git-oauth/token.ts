/**
 * Git OAuth token validation & refresh endpoint (ADA-611).
 *
 * `POST /api/git-oauth/token`
 *
 * Validates an internal access token and returns the associated GitHub user
 * info. Supports token refresh: when `{ refresh: true }` is sent with a
 * still-valid token, a new internal token is issued (with extended expiry)
 * so the frontend can rotate tokens before they expire without re-authenticating.
 *
 * Authentication: Bearer token in the Authorization header (the internal token
 * previously issued by /api/git-oauth/callback).
 *
 * Edge-runtime compatible.
 *
 * Linear: ADA-611.
 */

import {
	createInternalToken,
	verifyInternalToken,
	type GitOAuthEnv,
} from '../_lib/gitOAuth.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface TokenDeps {
	/** Environment overrides (tests). Defaults to `process.env`. */
	env?: GitOAuthEnv;
	/** Override "now" in ms (tests). */
	nowMs?: number;
}

export default async function handler(request: Request): Promise<Response> {
	return handleToken(request);
}

export async function handleToken(
	request: Request,
	deps: TokenDeps = {},
): Promise<Response> {
	const env = deps.env ?? (process.env as GitOAuthEnv);
	const nowMs = deps.nowMs ?? Date.now();

	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const secret = env.GIT_OAUTH_SECRET;
	if (!secret) {
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	// Extract the internal token from the Authorization header.
	const authHeader = request.headers.get('authorization');
	if (!authHeader) {
		return jsonResponse(401, { error: 'missing_token' });
	}

	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!match) {
		return jsonResponse(401, { error: 'invalid_token_format' });
	}

	const internalToken = match[1].trim();

	// Verify the internal token.
	let verified;
	try {
		verified = await verifyInternalToken(internalToken, secret, nowMs);
	} catch {
		verified = null;
	}

	if (!verified) {
		// Intentionally vague: we don't reveal whether the token was expired or forged.
		return jsonResponse(401, {
			error: 'invalid_token',
			detail: 'Token is invalid or expired. Re-authenticate via /api/git-oauth/authorize.',
		});
	}

	// Parse the request body for optional refresh.
	let refresh = false;
	try {
		const body = (await request.json()) as Record<string, unknown>;
		refresh = body.refresh === true;
	} catch {
		// No body or invalid JSON — fine, just validate.
	}

	let token: string;
	if (refresh) {
		// Issue a fresh internal token for the same GitHub user.
		token = await createInternalToken(
			verified.githubToken,
			{ id: verified.githubUserId, login: verified.githubLogin },
			secret,
			nowMs,
		);
	} else {
		token = internalToken;
	}

	return jsonResponse(200, {
		active: true,
		token,
		github_user_id: verified.githubUserId,
		github_login: verified.githubLogin,
		expires_at: verified.expiresAt,
	});
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
