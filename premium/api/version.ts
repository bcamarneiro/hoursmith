/**
 * Build/deployment info endpoint.
 *
 * `GET /api/version` returns the running version + commit + env so a paying
 * customer reporting a bug can be matched to an exact deploy, and so we can
 * see at a glance whether `main` or `staging` is what's serving a URL.
 *
 * Source of truth:
 *   - `VERSION` const here — bumped manually alongside `package.json` on each
 *     release (one place to update; the CI release flow nudges you). Keeping
 *     it as a literal avoids bundling-package-json gymnastics in Edge runtime.
 *   - Everything else (sha, branch, env, deployedAt) comes from Vercel's
 *     automatic build-time env vars; outside of Vercel they fall back to
 *     'dev' / 'local' so /api/version stays useful on `dev:offline`.
 *
 * Cached for 60s public — it's a heartbeat, not a hot path.
 */

import { corsHeaders } from './_lib/cors.js';

export const config = {
	runtime: 'edge',
};

// Bump alongside `package.json` `version` on each release tag. See README →
// "Releases" for the flow (`npm version <bump>` then `gh release create`).
const VERSION = '1.0.0';

export default function handler(request: Request): Response {
	const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev';
	const body = {
		version: VERSION,
		sha,
		shaShort: sha.slice(0, 7),
		branch: process.env.VERCEL_GIT_COMMIT_REF ?? 'local',
		env: process.env.VERCEL_ENV ?? 'development',
		deployedAt: process.env.VERCEL_DEPLOYMENT_CREATED_AT ?? null,
	};
	return new Response(JSON.stringify(body, null, 2), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=60',
			// The footer fetches this same-origin (no CORS needed); the allowlist
			// helper covers cross-origin preview URLs via APP_URL. No wildcard
			// ACAO anywhere under premium/api (ADA-297).
			...corsHeaders(request.headers.get('origin')),
		},
	});
}
