/**
 * Unit tests for `POST /api/providerConfig/test`.
 *
 * Linear: ADA-271.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin.js';
import { handleTestConnection } from '../test.js';

// ── Helpers ──

function makeRequest(body?: unknown): Request {
	return new Request('https://hoursmith.io/api/providerConfig/test', {
		method: 'POST',
		headers: {
			authorization: 'Bearer ok',
			'content-type': 'application/json',
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

function makeAdmin(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		getUserIdFromToken: vi.fn().mockResolvedValue('user-123'),
		getSubscription: vi.fn().mockResolvedValue({
			user_id: 'user-123',
			stripe_customer_id: 'polar_cus_1',
			stripe_subscription_id: 'polar_sub_1',
			tier: 'premium',
			status: 'active',
			current_period_end: null,
			updated_at: '2026-07-01T00:00:00.000Z',
		}),
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

function fakeProbe(
	status: number,
	body?: unknown,
): typeof fetch {
	return vi.fn().mockResolvedValue(
		new Response(
			status === 204 ? null : JSON.stringify(body),
			{ status },
		),
	) as unknown as typeof fetch;
}

// ── Auth gate ──

describe('auth gate', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const req = new Request(
			'https://hoursmith.io/api/providerConfig/test',
			{ method: 'POST', headers: { 'content-type': 'application/json' } },
		);
		const res = await handleTestConnection(req, { admin: makeAdmin() });
		expect(res.status).toBe(401);
	});

	it('returns 401 when JWT verifier returns null', async () => {
		const admin = makeAdmin({
			getUserIdFromToken: vi.fn().mockResolvedValue(null),
		});
		const res = await handleTestConnection(
			makeRequest({ provider: 'jira_api', apiKey: 'key', host: 'https://example.atlassian.net' }),
			{ admin },
		);
		expect(res.status).toBe(401);
	});

	it('rejects non-POST methods', async () => {
		const req = new Request(
			'https://hoursmith.io/api/providerConfig/test',
			{ method: 'GET', headers: { authorization: 'Bearer ok' } },
		);
		const res = await handleTestConnection(req, { admin: makeAdmin() });
		expect(res.status).toBe(405);
	});
});

// ── Input validation ──

describe('input validation', () => {
	it('rejects missing provider', async () => {
		const res = await handleTestConnection(
			makeRequest({ apiKey: 'key' }),
			{ admin: makeAdmin() },
		);
		expect(res.status).toBe(400);
	});

	it('rejects invalid provider', async () => {
		const res = await handleTestConnection(
			makeRequest({ provider: 'bogus', apiKey: 'key' }),
			{ admin: makeAdmin() },
		);
		expect(res.status).toBe(400);
	});

	it('rejects missing apiKey', async () => {
		const res = await handleTestConnection(
			makeRequest({ provider: 'jira_api' }),
			{ admin: makeAdmin() },
		);
		expect(res.status).toBe(400);
	});

	it('rejects invalid JSON body', async () => {
		const req = new Request(
			'https://hoursmith.io/api/providerConfig/test',
			{
				method: 'POST',
				headers: {
					authorization: 'Bearer ok',
					'content-type': 'application/json',
				},
				body: 'not json',
			},
		);
		const res = await handleTestConnection(req, {
			admin: makeAdmin(),
		});
		expect(res.status).toBe(400);
	});
});

// ── Jira probe ──

describe('jira_api connection test', () => {
	it('succeeds when the probe returns 200', async () => {
		const probe = fakeProbe(200, {
			emailAddress: 'user@example.com',
			displayName: 'Test User',
		});
		const res = await handleTestConnection(
			makeRequest({
				provider: 'jira_api',
				apiKey: 'token123',
				host: 'https://example.atlassian.net',
			}),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.label).toBe('user@example.com');
	});

	it('returns ok:false on 401 from the provider', async () => {
		const probe = fakeProbe(401);
		const res = await handleTestConnection(
			makeRequest({
				provider: 'jira_api',
				apiKey: 'bad-token',
				host: 'https://example.atlassian.net',
			}),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		expect(body.error).toContain('Invalid API key');
	});

	it('returns ok:false on 403 from the provider', async () => {
		const probe = fakeProbe(403);
		const res = await handleTestConnection(
			makeRequest({
				provider: 'jira_api',
				apiKey: 'token-no-perms',
				host: 'https://example.atlassian.net',
			}),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		expect(body.error).toContain('permissions');
	});

	it('returns ok:false on fetch error (network failure)', async () => {
		const probe = vi.fn().mockRejectedValue(new Error('fetch failed')) as unknown as typeof fetch;
		const res = await handleTestConnection(
			makeRequest({
				provider: 'jira_api',
				apiKey: 'token',
				host: 'https://example.atlassian.net',
			}),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		expect(body.error).toBeTruthy();
	});
});

// ── Other providers ──

describe('provider probes', () => {
	it('succeeds for github', async () => {
		const probe = fakeProbe(200, { login: 'octocat' });
		const res = await handleTestConnection(
			makeRequest({ provider: 'github', apiKey: 'ghp_token' }),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.label).toBe('octocat');
	});

	it('succeeds for gitlab', async () => {
		const probe = fakeProbe(200, { username: 'gitlab-user', email: 'gitlab@example.com' });
		const res = await handleTestConnection(
			makeRequest({ provider: 'gitlab', apiKey: 'glpat-token' }),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.label).toBe('gitlab@example.com');
	});

	it('succeeds for toggl', async () => {
		const probe = fakeProbe(200, { email: 'dev@toggl.com' });
		const res = await handleTestConnection(
			makeRequest({ provider: 'toggl', apiKey: 'toggle_token' }),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	it('succeeds for clockify', async () => {
		const probe = fakeProbe(200, { email: 'dev@clockify.me' });
		const res = await handleTestConnection(
			makeRequest({ provider: 'clockify', apiKey: 'clockify_key' }),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	it('succeeds for harvest', async () => {
		const probe = fakeProbe(200, {
			first_name: 'Dev',
			last_name: 'User',
		});
		const res = await handleTestConnection(
			makeRequest({ provider: 'harvest', apiKey: 'harvest_token' }),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	it('succeeds for rescuetime', async () => {
		const probe = fakeProbe(200, {});
		const res = await handleTestConnection(
			makeRequest({ provider: 'rescuetime', apiKey: 'rt_token' }),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
	});

	it('succeeds for custom (no-op probe)', async () => {
		const res = await handleTestConnection(
			makeRequest({ provider: 'custom', apiKey: 'my-secret' }),
			{ admin: makeAdmin() },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.note).toBeTruthy();
	});
});

// ── Entitlement gate (ADA-272) ──

describe('entitlement gate', () => {
	it('returns 403 when subscription is not active', async () => {
		const admin = makeAdmin({
			getSubscription: vi.fn().mockResolvedValue(null),
		});
		const res = await handleTestConnection(
			makeRequest({ provider: 'github', apiKey: 'ghp_token' }),
			{ admin },
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe('subscription_required');
	});

	it('returns 403 for canceled subscriptions', async () => {
		const admin = makeAdmin({
			getSubscription: vi.fn().mockResolvedValue({
				user_id: 'user-123',
				stripe_customer_id: 'polar_cus_1',
				stripe_subscription_id: 'polar_sub_1',
				tier: 'premium',
				status: 'canceled',
				current_period_end: null,
				updated_at: '2026-07-01T00:00:00.000Z',
			}),
		});
		const res = await handleTestConnection(
			makeRequest({ provider: 'github', apiKey: 'ghp_token' }),
			{ admin },
		);
		expect(res.status).toBe(403);
	});
});

// ── SSRF guard ──

describe('SSRF guard', () => {
	it('rejects custom host with HTTP scheme', async () => {
		const res = await handleTestConnection(
			makeRequest({
				provider: 'jira_api',
				apiKey: 'token',
				host: 'http://example.atlassian.net',
			}),
			{ admin: makeAdmin() },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toContain('HTTPS');
	});

	it('rejects custom host with private IP (127.0.0.1)', async () => {
		const res = await handleTestConnection(
			makeRequest({
				provider: 'jira_api',
				apiKey: 'token',
				host: 'https://127.0.0.1',
			}),
			{ admin: makeAdmin() },
		);
		expect(res.status).toBe(400);
	});

	it('rejects custom host with private IP (10.x.x.x)', async () => {
		const res = await handleTestConnection(
			makeRequest({
				provider: 'jira_api',
				apiKey: 'token',
				host: 'https://10.0.0.1',
			}),
			{ admin: makeAdmin() },
		);
		expect(res.status).toBe(400);
	});

	it('rejects unparseable URLs', async () => {
		const res = await handleTestConnection(
			makeRequest({
				provider: 'jira_api',
				apiKey: 'token',
				host: 'not-a-url',
			}),
			{ admin: makeAdmin() },
		);
		expect(res.status).toBe(400);
	});

	it('accepts valid HTTPS hostname', async () => {
		const probe = fakeProbe(200, { emailAddress: 'user@example.com' });
		const res = await handleTestConnection(
			makeRequest({
				provider: 'jira_api',
				apiKey: 'token',
				host: 'https://my-company.atlassian.net',
			}),
			{ admin: makeAdmin(), probeFetch: probe },
		);
		expect(res.status).toBe(200);
	});
});
