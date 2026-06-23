/**
 * Shared CORS policy for every premium edge endpoint (ADA-297).
 *
 * Reflects the request Origin against an allowlist instead of sending
 * `Access-Control-Allow-Origin: *`. Supabase JWTs live in localStorage, so a
 * wildcard ACAO would let any third-party page read cross-origin responses and
 * amplify any XSS into token theft. A disallowed Origin gets **no** ACAO header,
 * so the browser blocks the cross-origin read. `Vary: Origin` keeps shared
 * caches from serving one origin's ACAO to another.
 */

type Env = Partial<Record<string, string | undefined>>;

const STATIC_ALLOWED_ORIGINS = [
	'https://hoursmith.io',
	'https://www.hoursmith.io',
	'https://staging.hoursmith.io',
	'http://localhost:5173',
	'http://localhost:5174',
	'http://127.0.0.1:5173',
	'http://127.0.0.1:5174',
];

function allowedOrigins(env: Env): Set<string> {
	const set = new Set(STATIC_ALLOWED_ORIGINS);
	// Allow the deployment's own origin (e.g. a preview URL) when APP_URL is set.
	const appUrl = env.APP_URL?.replace(/\/+$/, '');
	if (appUrl) set.add(appUrl);
	return set;
}

/**
 * CORS headers for a response. An allowlisted `origin` is reflected exactly;
 * anything else emits no `Access-Control-Allow-Origin`. Pass the request's
 * `Origin` header (`request.headers.get('origin')`).
 */
export function corsHeaders(
	origin: string | null,
	env: Env = process.env,
): Record<string, string> {
	const headers: Record<string, string> = {
		'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
		'access-control-allow-headers':
			'Authorization, Content-Type, Accept, X-Jira-Base, X-Jira-Auth, X-Atlassian-Token, X-RescueTime-Key',
		'access-control-expose-headers': 'Content-Type, Content-Length',
		'access-control-max-age': '86400',
		vary: 'Origin',
	};
	if (origin && allowedOrigins(env).has(origin)) {
		headers['access-control-allow-origin'] = origin;
	}
	return headers;
}
