// @vitest-environment node
//
// The mock permanent-error layer is exercised against `msw/node`'s
// `setupServer`, which intercepts real `fetch()` calls — the same wire format
// the browser worker (`frontend/mocks/browser.ts`) uses in offline/E2E mode.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { fromHttpResponseAsync } from '../../services/serviceErrors';
import {
	createPermanentErrorHandlers,
	getPermanentErrorScenario,
	MOCK_ERROR_QUERY_PARAM,
	PERMANENT_ERROR_SCENARIOS,
} from '../permanentErrors';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('getPermanentErrorScenario', () => {
	it('resolves a known scenario id from the query string', () => {
		const scenario = getPermanentErrorScenario(`?${MOCK_ERROR_QUERY_PARAM}=myself-401`);
		expect(scenario?.id).toBe('myself-401');
		expect(scenario?.status).toBe(401);
		expect(scenario?.kind).toBe('unauthorized');
	});

	it('returns null when the query param is absent', () => {
		expect(getPermanentErrorScenario('?theme=dark')).toBeNull();
		expect(getPermanentErrorScenario('')).toBeNull();
	});

	it('returns null for an unknown scenario id', () => {
		expect(
			getPermanentErrorScenario(`?${MOCK_ERROR_QUERY_PARAM}=no-such-scenario`),
		).toBeNull();
	});

	it('keeps a unique, non-empty scenario registry', () => {
		const ids = Object.values(PERMANENT_ERROR_SCENARIOS).map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const scenario of Object.values(PERMANENT_ERROR_SCENARIOS)) {
			expect(scenario.endpoints.length).toBeGreaterThan(0);
			expect(scenario.networkError ? scenario.status : scenario.status).toBeDefined();
		}
	});
});

describe('createPermanentErrorHandlers', () => {
	it('returns 401 for the myself-401 scenario and never recovers', async () => {
		const scenario = PERMANENT_ERROR_SCENARIOS['myself-401'];
		server.use(...createPermanentErrorHandlers(scenario));

		const url = 'https://my.atlassian.net/rest/api/2/myself';
		for (let attempt = 0; attempt < 3; attempt++) {
			const res = await fetch(url);
			expect(res.status).toBe(401);
			const err = await fromHttpResponseAsync('Connection test', res.clone());
			expect(err.kind).toBe('unauthorized');
			expect(err.status).toBe(401);
			const body = (await res.json()) as { errorMessages?: string[] };
			expect(body.errorMessages?.[0]).toContain('Unauthorized');
		}
	});

	it('returns 403 for the myself-403 scenario', async () => {
		server.use(...createPermanentErrorHandlers(PERMANENT_ERROR_SCENARIOS['myself-403']));
		const res = await fetch('https://my.atlassian.net/rest/api/2/myself');
		expect(res.status).toBe(403);
		const err = await fromHttpResponseAsync('Connection test', res.clone());
		expect(err.kind).toBe('forbidden');
	});

	it('returns 404 for the myself-404 scenario', async () => {
		server.use(...createPermanentErrorHandlers(PERMANENT_ERROR_SCENARIOS['myself-404']));
		const res = await fetch('https://my.atlassian.net/rest/api/2/myself');
		expect(res.status).toBe(404);
		const err = await fromHttpResponseAsync('Connection test', res.clone());
		expect(err.kind).toBe('not-found');
	});

	it('rejects the fetch for the myself-network scenario', async () => {
		server.use(
			...createPermanentErrorHandlers(PERMANENT_ERROR_SCENARIOS['myself-network']),
		);
		await expect(
			fetch('https://my.atlassian.net/rest/api/2/myself'),
		).rejects.toThrow();
	});

	it('returns 500 for every JQL search endpoint in the search-500 scenario', async () => {
		server.use(...createPermanentErrorHandlers(PERMANENT_ERROR_SCENARIOS['search-500']));

		const v3 = await fetch(
			'https://acme.atlassian.net/rest/api/3/search/jql?jql=project%3DPLAY',
		);
		expect(v3.status).toBe(500);
		const err = await fromHttpResponseAsync('Jira search', v3.clone());
		expect(err.kind).toBe('server-error');

		const v2 = await fetch(
			'https://acme.atlassian.net/rest/api/2/search?jql=project%3DPLAY',
		);
		expect(v2.status).toBe(500);
	});

	it('returns 500 for worklog creation in the worklog-create-500 scenario', async () => {
		server.use(
			...createPermanentErrorHandlers(PERMANENT_ERROR_SCENARIOS['worklog-create-500']),
		);
		const res = await fetch('https://acme.atlassian.net/rest/api/2/issue/DEV-1/worklog', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ timeSpentSeconds: 3600 }),
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { errorMessages?: string[] };
		expect(body.errorMessages?.[0]).toContain('not saved');
	});

	it('returns 403 for worklog deletion in the worklog-delete-403 scenario', async () => {
		server.use(
			...createPermanentErrorHandlers(PERMANENT_ERROR_SCENARIOS['worklog-delete-403']),
		);
		const res = await fetch(
			'https://acme.atlassian.net/rest/api/2/issue/DEV-1/worklog/12345',
			{ method: 'DELETE' },
		);
		expect(res.status).toBe(403);
		const err = await fromHttpResponseAsync('Jira worklog', res.clone());
		expect(err.kind).toBe('forbidden');
	});
});
