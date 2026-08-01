/**
 * Tests for the test-env mock network with error injection (ADA-758).
 *
 * Proves the infrastructure behaves like a proxy over the production mock
 * handlers by default, and that each fault type — HTTP error, timeout, network
 * error — reliably changes the observed behaviour for the matched route only,
 * with `resetErrorInjection()` restoring the real mock network.
 */
import { describe, expect, it } from 'vitest';
import {
	installMockServerHooks,
	resetErrorInjection,
	simulateHttpError,
	simulateNetworkError,
	simulateTimeout,
} from '../testServer';

installMockServerHooks();

const SEARCH_PATTERN = 'https://*.atlassian.net/rest/api/3/search/jql';
const SEARCH_URL =
	'https://mock.atlassian.net/rest/api/3/search/jql?jql=worklogDate%20%3E%3D%20%222026-06-01%22&fields=summary,worklog';
const ISSUE_PATTERN = 'https://*.atlassian.net/rest/api/2/issue/DEV-1';
const ISSUE_URL = 'https://mock.atlassian.net/rest/api/2/issue/DEV-1';

async function fetchJson(url: string): Promise<{
	status: number;
	body: unknown;
}> {
	const res = await fetch(url);
	return { status: res.status, body: await res.json() };
}

describe('mock network proxy (no injection)', () => {
	it('serves the production mock handlers by default', async () => {
		const { status, body } = await fetchJson(SEARCH_URL);
		expect(status).toBe(200);
		// The production v3 search handler always flags the page as last.
		expect(body).toMatchObject({ isLast: true, issues: expect.any(Array) });
	});
});

describe('simulateHttpError', () => {
	it('returns the injected status and body for the matched route', async () => {
		simulateHttpError(SEARCH_PATTERN, 503, {
			body: { message: 'Jira is down for maintenance' },
		});

		const { status, body } = await fetchJson(SEARCH_URL);
		expect(status).toBe(503);
		expect(body).toEqual({ message: 'Jira is down for maintenance' });
	});

	it('only faults the matched route — other routes keep mock data', async () => {
		simulateHttpError(SEARCH_PATTERN, 503);

		const search = await fetchJson(SEARCH_URL);
		const issue = await fetchJson(ISSUE_URL);
		expect(search.status).toBe(503);
		expect(issue.status).toBe(200);
		expect(issue.body).toMatchObject({ key: 'DEV-1' });
	});

	it('supports response headers (e.g. Retry-After for 429 tests)', async () => {
		simulateHttpError(SEARCH_PATTERN, 429, {
			body: { message: 'Rate limit exceeded' },
			headers: { 'retry-after': '1' },
		});

		const res = await fetch(SEARCH_URL);
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe('1');
	});
});

describe('simulateTimeout', () => {
	it('holds the request until the client aborts (real upstream timeout)', async () => {
		simulateTimeout(ISSUE_PATTERN);

		await expect(
			fetch(ISSUE_URL, { signal: AbortSignal.timeout(50) }),
		).rejects.toMatchObject({ name: 'TimeoutError' });
	});

	it('returns a 504 Gateway Timeout when delayMs elapses first', async () => {
		simulateTimeout(ISSUE_PATTERN, { delayMs: 20 });

		// Client timeout is far longer than the proxy-side delay, so the
		// mock answers 504 instead of the client aborting.
		const { status, body } = await fetchJson(ISSUE_URL);
		expect(status).toBe(504);
		expect(body).toEqual({ message: 'upstream timeout' });
	});
});

describe('simulateNetworkError', () => {
	it('drops the connection — fetch rejects like a dead network', async () => {
		simulateNetworkError(SEARCH_PATTERN);

		await expect(fetch(SEARCH_URL)).rejects.toThrow(TypeError);
	});
});

describe('resetErrorInjection', () => {
	it('restores the production mock handlers after a fault', async () => {
		simulateHttpError(SEARCH_PATTERN, 500);
		expect((await fetchJson(SEARCH_URL)).status).toBe(500);

		resetErrorInjection();

		const { status, body } = await fetchJson(SEARCH_URL);
		expect(status).toBe(200);
		expect(body).toMatchObject({ isLast: true });
	});

	it('clears every fault type at once', async () => {
		simulateHttpError(SEARCH_PATTERN, 500);
		simulateNetworkError(ISSUE_PATTERN);

		resetErrorInjection();

		expect((await fetchJson(SEARCH_URL)).status).toBe(200);
		await expect(fetch(ISSUE_URL)).resolves.toBeInstanceOf(Response);
	});
});
