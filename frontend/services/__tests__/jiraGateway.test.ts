/**
 * Tests for the Jira gateway routing seam (ADA-273, ADA-447).
 *
 * Focus: an authenticated Premium user must route through the hosted proxy
 * (`${origin}/api/proxy`) from the *very first* request on a cold page load —
 * never direct to Atlassian (which CORS-fails). The bridge self-bootstraps from
 * the persisted Supabase session in localStorage at module init so the gateway
 * sees the hosted URL before the `useSubscription` effect has had a chance to
 * run (ADA-447). Free / self-host users (no Supabase token) keep their own
 * proxy or direct mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SUPABASE_KEY = 'sb-abcd1234-auth-token';

function seedSupabaseSession(accessToken: string): void {
	window.localStorage.setItem(
		SUPABASE_KEY,
		JSON.stringify({ access_token: accessToken, token_type: 'bearer' }),
	);
}

async function importGateway() {
	// Re-import after seeding localStorage so the module-init bootstrap runs
	// against the state under test.
	vi.resetModules();
	return import('../jiraGateway');
}

beforeEach(() => {
	window.localStorage.clear();
});

afterEach(() => {
	window.localStorage.clear();
	vi.resetModules();
});

describe('jiraGateway cold-load routing (ADA-447)', () => {
	it('routes to <origin>/api/proxy when a persisted Supabase token is present', async () => {
		seedSupabaseSession('jwt-token-123');
		const { getJiraGatewayMode, rewriteForHostedProxy } = await importGateway();

		// No user-configured proxy at all — pre-fix this would have been "direct".
		expect(getJiraGatewayMode('')).toBe('hosted');

		const original =
			'https://acme.atlassian.net/rest/api/3/search/jql?jql=worklogAuthor%3DcurrentUser()';
		const { url, headers } = rewriteForHostedProxy(
			original,
			{ Authorization: 'Bearer jira-token', Accept: 'application/json' },
			{ jiraHost: 'acme.atlassian.net', email: 'a@b.com', apiToken: 'tok' },
		);

		expect(url).toBe(
			`${window.location.origin}/api/proxy/rest/api/3/search/jql?jql=worklogAuthor%3DcurrentUser()`,
		);
		// Supabase JWT moves into Authorization; Jira credential into X-Jira-Auth.
		expect(headers.authorization).toBe('Bearer jwt-token-123');
		expect(headers['x-jira-base']).toBe('https://acme.atlassian.net');
		expect(headers['x-jira-auth']).toBe(`Basic ${btoa('a@b.com:tok')}`);
		// The original Jira bearer must not survive.
		expect(headers.Authorization).toBeUndefined();
	});

	it('stays direct for a signed-out user with no proxy configured', async () => {
		const { getJiraGatewayMode, rewriteForHostedProxy } = await importGateway();
		expect(getJiraGatewayMode('')).toBe('direct');

		const original = 'https://acme.atlassian.net/rest/api/3/search/jql?jql=x';
		const headers = { Authorization: 'Bearer jira-token' };
		const out = rewriteForHostedProxy(original, headers, {
			jiraHost: 'acme.atlassian.net',
			email: 'a@b.com',
			apiToken: 'tok',
		});
		// No-op in direct mode — URL + headers pass through unchanged.
		expect(out.url).toBe(original);
		expect(out.headers).toBe(headers);
	});

	it('uses the self-hosted proxy for a signed-out user who configured one', async () => {
		const { getJiraGatewayMode } = await importGateway();
		expect(getJiraGatewayMode('https://my-proxy.example')).toBe('self-hosted');
	});

	it('ignores malformed persisted sessions and stays direct', async () => {
		window.localStorage.setItem(SUPABASE_KEY, 'not-json{');
		const { getJiraGatewayMode } = await importGateway();
		expect(getJiraGatewayMode('')).toBe('direct');
	});

	it('explicit setHostedProxyUrl still overrides regardless of bootstrap', async () => {
		const { getJiraGatewayMode } = await importGateway();
		const { setHostedProxyUrl } = await import('../proxyUrlBridge');
		setHostedProxyUrl('https://hosted.example/api/proxy');
		expect(getJiraGatewayMode('https://my-proxy.example')).toBe('hosted');
	});
});
