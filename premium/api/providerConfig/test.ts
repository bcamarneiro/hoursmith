/**
 * Provider connection test endpoint for Hoursmith Premium (ADA-271).
 *
 * POST /api/providerConfig/test
 * Body: { provider, apiKey, host? }
 *
 * Validates a provider's API credentials by making a lightweight probe
 * request (e.g. /myself for Jira, /user for GitLab). The actual API key
 * is sent from the server and is NEVER persisted or logged.
 *
 * Supported providers and their probe endpoints:
 *   jira_api     — GET {host}/rest/api/2/myself (Basic auth)
 *   gitlab       — GET https://gitlab.com/api/v4/user
 *   github       — GET https://api.github.com/user
 *   toggl        — GET https://api.track.toggl.com/api/v9/me
 *   harvest      — GET https://api.harvestapp.com/v2/users/me
 *   clockify     — GET https://api.clockify.me/api/v1/user
 *   rescuetime   — GET https://www.rescuetime.com/api/oauth/data (limited probe)
 *
 * Logging discipline:
 *   DO log:    timestamp, user_id (post-verification), provider, outcome.
 *   DO NOT log: apiKey values, Authorization headers, probe response bodies.
 */

import { isTokenProvider, type TokenProvider } from '../_lib/tokenStorage.js';
import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';
import { getEntitlement } from '../_lib/entitlement.js';
import { checkRateLimit } from '../_lib/rateLimit.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

// ── SSRF guard ──

/**
 * Patterns that match private / reserved / loopback IPv4 addresses.
 * These MUST be rejected when a caller supplies a custom host (jira_api).
 */
const PRIVATE_IP_PATTERNS = [
	/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
	/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
	/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
	/^192\.168\.\d{1,3}\.\d{1,3}$/,
	/^169\.254\.\d{1,3}\.\d{1,3}$/,
	/^0\.0\.0\.0$/,
];

const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIP(hostname: string): boolean {
	const match = hostname.match(IPV4_REGEX);
	if (!match) return false;

	const octets = match.slice(1).map(Number);
	if (octets.some((o) => o > 255)) return false; // invalid IP

	return PRIVATE_IP_PATTERNS.some((p) => p.test(hostname));
}

/**
 * Validate a caller-supplied provider host URL.
 *
 * Rejects:
 *  - Non-HTTPS URLs
 *  - Raw IP addresses in private / reserved ranges
 *  - Unparseable URLs
 */
function validateProbeHost(raw: string): string {
	const url = safeParseURL(raw);
	if (url.protocol !== 'https:') {
		throw new ValidationError(
			'Host URL must use HTTPS. Plain HTTP is not accepted.',
		);
	}
	if (isPrivateIP(url.hostname)) {
		throw new ValidationError(
			'Host URL resolves to a private or reserved IP address.',
		);
	}
	return url.origin;
}

class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ValidationError';
	}
}

function safeParseURL(raw: string): URL {
	try {
		return new URL(raw);
	} catch (err) {
		throw new ValidationError(
			`Invalid host URL: ${(err as Error).message}`,
		);
	}
}

// ── Request / response shapes ──

export interface TestConnectionRequest {
	provider: string;
	apiKey: string;
	host?: string;
}

export interface TestConnectionDeps {
	admin?: SupabaseAdminClient;
	/** Inject a fetch-like function for tests. */
	probeFetch?: typeof fetch;
}

// ── Provider probe configurations ──

interface ProbeConfig {
	url: (host?: string) => string;
	headers: (apiKey: string, host?: string) => Record<string, string>;
}

const PROBE_CONFIGS: Partial<Record<TokenProvider, ProbeConfig>> = {
	jira_api: {
		url: (host) => {
			const base = host ?? 'https://your-domain.atlassian.net';
			return `${base.replace(/\/$/, '')}/rest/api/2/myself`;
		},
		headers: (apiKey, host) => {
			// Jira Cloud expects `Authorization: Basic base64(email:token)`.
			// If the key contains `:` it's assumed to be `email:token`; otherwise
			// it's an API token and the email must be combined by the client.
			const credential = btoa(apiKey.includes(':') ? apiKey : `:${apiKey}`);
			return {
				Authorization: `Basic ${credential}`,
				Accept: 'application/json',
				'X-Atlassian-Token': 'no-check',
			};
		},
	},
	gitlab: {
		url: () => 'https://gitlab.com/api/v4/user',
		headers: (apiKey) => ({
			'PRIVATE-TOKEN': apiKey,
			Accept: 'application/json',
		}),
	},
	github: {
		url: () => 'https://api.github.com/user',
		headers: (apiKey) => ({
			Authorization: `Bearer ${apiKey}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'hoursmith/1.0',
		}),
	},
	toggl: {
		url: () => 'https://api.track.toggl.com/api/v9/me',
		headers: (apiKey) => ({
			Authorization: `Basic ${btoa(`${apiKey}:api_token`)}`,
			'Content-Type': 'application/json',
		}),
	},
	harvest: {
		url: () => 'https://api.harvestapp.com/v2/users/me',
		headers: (apiKey) => ({
			Authorization: `Bearer ${apiKey}`,
			'Harvest-Account-ID': apiKey,
			'User-Agent': 'hoursmith/1.0',
		}),
	},
	clockify: {
		url: () => 'https://api.clockify.me/api/v1/user',
		headers: (apiKey) => ({
			'X-Api-Key': apiKey,
			'Content-Type': 'application/json',
		}),
	},
	rescuetime: {
		url: () =>
			'https://www.rescuetime.com/api/oauth/data?format=json&version=0',
		headers: (apiKey) => ({
			Authorization: `Bearer ${apiKey}`,
		}),
	},
	custom: {
		// For 'custom' providers there is no standard probe; we still allow
		// a connectivity check but it's a no-op success — the caller validates
		// storage, not the third-party endpoint.
		url: () => '',
		headers: () => ({}),
	},
};

// ── Handler ──

export default async function handler(request: Request): Promise<Response> {
	return handleTestConnection(request);
}

export async function handleTestConnection(
	request: Request,
	deps: TestConnectionDeps = {},
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		logEvent({ userId: null, status: 401, note: 'missing_token' });
		return jsonResponse(401, { error: 'missing_token' });
	}

	let admin: SupabaseAdminClient;
	try {
		admin = deps.admin ?? defaultSupabaseAdmin();
	} catch (err) {
		logEvent({
			userId: null,
			status: 500,
			note: `server_misconfigured:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	const userId = await admin.getUserIdFromToken(token);
	if (!userId) {
		logEvent({ userId: null, status: 401, note: 'invalid_token' });
		return jsonResponse(401, { error: 'invalid_token' });
	}

	// Entitlement gate — require active premium subscription (ADA-272).
	const subscription = await admin.getSubscription(userId);
	const entitled =
		subscription?.status === 'active' ||
		subscription?.status === 'trialing' ||
		subscription?.status === 'past_due';
	if (!entitled) {
		logEvent({ userId, status: 403, note: 'subscription_required' });
		return jsonResponse(403, { error: 'subscription_required' });
	}

	// Rate limit guard — shared with the CORS proxy (ADA-302).
	const rate = await checkRateLimit(userId);
	if (!rate.allowed) {
		const headers = new Headers();
		headers.set('Retry-After', String(rate.retryAfterSeconds));
		return new Response(
			JSON.stringify({
				error: 'rate_limit_exceeded',
				retryAfterSeconds: rate.retryAfterSeconds,
			}),
			{ status: 429, headers },
		);
	}

	let body: TestConnectionRequest;
	try {
		body = (await request.json()) as TestConnectionRequest;
	} catch {
		return jsonResponse(400, { error: 'invalid_json' });
	}

	if (!body.provider || !isTokenProvider(body.provider)) {
		return jsonResponse(400, {
			error: 'invalid_provider',
			valid: [
				'jira_api',
				'gitlab',
				'rescuetime',
				'github',
				'toggl',
				'harvest',
				'clockify',
				'custom',
			],
		});
	}

	if (!body.apiKey || typeof body.apiKey !== 'string' || body.apiKey.trim().length === 0) {
		return jsonResponse(400, { error: 'api_key_required' });
	}

	const provider = body.provider as TokenProvider;
	const probeConfig = PROBE_CONFIGS[provider];

	if (!probeConfig) {
		return jsonResponse(400, { error: 'unsupported_provider' });
	}

	const fetchImpl = deps.probeFetch ?? fetch;

	// SSRF guard: validate caller-supplied host (jira_api only).
	if (provider === 'jira_api' && body.host) {
		try {
			body.host = validateProbeHost(body.host);
		} catch (err) {
			if (err instanceof ValidationError) {
				logEvent({ userId, provider, status: 400, note: `ssrf_guard:${err.message}` });
				return jsonResponse(400, { error: `Invalid host: ${err.message}` });
			}
			throw err;
		}
	}

	try {
		// 'custom' is a special case — it has no probe endpoint, so we return
		// a synthetic success. The real validation is that we can store it.
		if (provider === 'custom') {
			logEvent({ userId, provider, status: 200, note: 'custom_no_probe' });
			return jsonResponse(
				200,
				{
					ok: true,
					provider,
					note: 'Custom providers cannot be probed; the API key will be stored as-is.',
				} as unknown as Record<string, unknown>,
			);
		}

		const url = probeConfig.url(body.host);
		const headers = probeConfig.headers(body.apiKey.trim(), body.host);

		const res = await fetchImpl(url, {
			method: 'GET',
			headers,
			redirect: 'manual',
		});

		// 2xx means the credentials are valid.
		if (res.ok) {
			let accountLabel: string | null = null;
			try {
				const data = (await res.json()) as Record<string, unknown>;
				accountLabel = extractAccountLabel(provider, data);
			} catch {
				// If the response body isn't JSON, that's fine — we still consider
				// the connection valid.
			}

			logEvent({ userId, provider, status: 200 });
			return jsonResponse(
				200,
				{
					ok: true,
					provider,
					label: accountLabel,
				} as unknown as Record<string, unknown>,
			);
		}

		// Non-2xx: extract a meaningful error hint from the response.
		const reason = await deriveFailureReason(res, provider);
		logEvent({ userId, provider, status: res.status, note: reason });
		return jsonResponse(
			200,
			{
				ok: false,
				provider,
				error: reason,
			} as unknown as Record<string, unknown>,
		);
	} catch (err) {
		const message =
			err instanceof Error ? err.message : 'unknown_error';
		logEvent({
			userId,
			provider,
			status: 500,
			note: `probe_failed:${message}`,
		});
		return jsonResponse(
			200,
			{
				ok: false,
				provider,
				error: `Could not reach the ${provider} API. Check that the host is reachable and your API key has the right permissions.`,
			} as unknown as Record<string, unknown>,
		);
	}
}

// ── Helpers ──

/**
 * Extract a human-readable account identifier from a successful probe.
 * Used to auto-fill the token label (e.g. "john@example.com — jira_api").
 */
function extractAccountLabel(
	provider: TokenProvider,
	data: Record<string, unknown>,
): string | null {
	switch (provider) {
		case 'jira_api':
			return (
				(data.emailAddress as string) ??
				(data.name as string) ??
				(data.displayName as string) ??
				(data.key as string) ??
				null
			);
		case 'gitlab':
			return (
				(data.email as string) ??
				(data.username as string) ??
				(data.name as string) ??
				null
			);
		case 'github':
			return (data.login as string) ?? null;
		case 'toggl':
			return (data.email as string) ?? (data.fullname as string) ?? null;
		case 'harvest':
			return (
				(data.email as string) ??
				(`${(data.first_name as string) ?? ''} ${(data.last_name as string) ?? ''}`.trim() ||
					null)
			);
		case 'clockify':
			return (data.email as string) ?? (data.name as string) ?? null;
		case 'rescuetime':
			// RescueTime OAuth data response doesn't carry a user-friendly
			// identifier in the data endpoint.
			return null;
		default:
			return null;
	}
}

/**
 * Derive a user-facing failure reason from the probe response.
 */
async function deriveFailureReason(
	res: Response,
	provider: string,
): Promise<string> {
	const status = res.status;
	if (status === 401) {
		return `Invalid API key for ${provider}. Check your credentials and try again.`;
	}
	if (status === 403) {
		return `The API key for ${provider} doesn't have the required permissions.`;
	}
	if (status === 404) {
		return `The ${provider} API endpoint was not found. Check that the host URL is correct.`;
	}
	if (status >= 500) {
		return `The ${provider} API is currently unreachable (HTTP ${status}). Try again in a moment.`;
	}
	return `Unexpected response from ${provider} API (HTTP ${status}).`;
}

function extractBearer(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

interface LogFields {
	userId: string | null;
	provider?: string;
	status: number;
	note?: string;
}

function logEvent(fields: LogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-provider-test',
			user_id: fields.userId,
			provider: fields.provider,
			status: fields.status,
			...(fields.note ? { note: fields.note } : {}),
		}),
	);
}
