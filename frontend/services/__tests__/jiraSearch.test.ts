/**
 * Tests for the shared Jira search seam (ADA-383).
 *
 * Cloud (`*.atlassian.net`) uses `/rest/api/3/search/jql` with cursor
 * pagination (`nextPageToken`); Server/DC uses `/rest/api/2/search` with
 * `startAt`/`total` offset pagination.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fetchSearchPage,
	isCloudJira,
	type JiraSearchConfig,
	searchAllIssues,
} from '../jiraSearch';

const cloudConfig: JiraSearchConfig = {
	jiraHost: 'example.atlassian.net',
	email: 'dev@example.com',
	apiToken: 'token',
	corsProxy: '',
};

const serverConfig: JiraSearchConfig = {
	jiraHost: 'jira.internal.example.com',
	email: 'dev@example.com',
	apiToken: 'token',
	corsProxy: '',
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('isCloudJira', () => {
	it('detects atlassian.net hosts', () => {
		expect(isCloudJira('example.atlassian.net')).toBe(true);
		expect(isCloudJira('https://example.atlassian.net')).toBe(true);
		expect(isCloudJira('https://example.atlassian.net/rest/api/2/search')).toBe(
			true,
		);
		expect(isCloudJira('EXAMPLE.ATLASSIAN.NET')).toBe(true);
	});

	it('treats Server/DC and other hosts as non-Cloud', () => {
		expect(isCloudJira('jira.internal.example.com')).toBe(false);
		expect(isCloudJira('atlassian.net.evil.com')).toBe(false);
		expect(isCloudJira('')).toBe(false);
	});
});

describe('fetchSearchPage', () => {
	it('hits /rest/api/3/search/jql on Cloud and returns the cursor', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				issues: [{ key: 'PROJ-1', fields: {} }],
				nextPageToken: 'tok-2',
			}),
		} as Response);

		const result = await fetchSearchPage(cloudConfig, {
			jql: 'project = PROJ',
			fields: 'key,summary',
			maxResults: 50,
		});

		const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
		expect(calledUrl).toContain('/rest/api/3/search/jql');
		expect(calledUrl).not.toContain('startAt');
		expect(result.issues).toHaveLength(1);
		expect(result.total).toBeUndefined();
		expect(result.nextPageToken).toBe('tok-2');
	});

	it('suppresses the cursor when isLast is true on Cloud', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				issues: [{ key: 'PROJ-1', fields: {} }],
				nextPageToken: 'tok-2',
				isLast: true,
			}),
		} as Response);

		const result = await fetchSearchPage(cloudConfig, {
			jql: 'project = PROJ',
			fields: 'key',
			maxResults: 50,
		});

		expect(result.nextPageToken).toBeUndefined();
	});

	it('hits /rest/api/2/search with startAt on Server/DC and returns total', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				issues: [{ key: 'PROJ-1', fields: {} }],
				total: 1,
			}),
		} as Response);

		const result = await fetchSearchPage(serverConfig, {
			jql: 'project = PROJ',
			fields: 'key',
			maxResults: 50,
			startAt: 0,
		});

		const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
		expect(calledUrl).toContain('/rest/api/2/search');
		expect(calledUrl).toContain('startAt=0');
		expect(calledUrl).not.toContain('/search/jql');
		expect(result.total).toBe(1);
		expect(result.nextPageToken).toBeUndefined();
	});

	it('throws a ServiceError when the response is not ok', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 410,
			clone: () => ({ json: async () => ({}) }),
			json: async () => ({}),
		} as unknown as Response);

		await expect(
			fetchSearchPage(cloudConfig, {
				jql: 'x',
				fields: 'key',
				maxResults: 10,
			}),
		).rejects.toMatchObject({ name: 'ServiceError', source: 'Jira search' });
	});

	it('captures the hosted-proxy entitlement code from a 401 body (ADA-475)', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 401,
			clone: () => ({ json: async () => ({ error: 'invalid_token' }) }),
			json: async () => ({ error: 'invalid_token' }),
		} as unknown as Response);

		await expect(
			fetchSearchPage(cloudConfig, { jql: 'x', fields: 'key', maxResults: 10 }),
		).rejects.toMatchObject({
			name: 'ServiceError',
			status: 401,
			entitlementCode: 'invalid_token',
		});
	});

	it('leaves entitlementCode undefined on a genuine Jira 401 (no code body)', async () => {
		vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 401,
			clone: () => ({ json: async () => ({}) }),
			json: async () => ({}),
		} as unknown as Response);

		await fetchSearchPage(cloudConfig, {
			jql: 'x',
			fields: 'key',
			maxResults: 10,
		}).catch((err) => {
			expect(err.status).toBe(401);
			expect(err.entitlementCode).toBeUndefined();
		});
	});
});

describe('searchAllIssues', () => {
	it('follows nextPageToken across pages on Cloud', async () => {
		const fetchMock = vi
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					issues: [{ key: 'A-1', fields: {} }],
					nextPageToken: 'tok-2',
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					issues: [{ key: 'A-2', fields: {} }],
				}),
			} as Response);

		const pages: number[] = [];
		const issues = await searchAllIssues<{ key: string }>(
			cloudConfig,
			{ jql: 'project = A', fields: 'key', maxResults: 1 },
			{ onPage: (_p, info) => pages.push(info.fetched) },
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(issues.map((i) => i.key)).toEqual(['A-1', 'A-2']);
		expect(pages).toEqual([1, 2]);
		// Second request must carry the cursor.
		expect(fetchMock.mock.calls[1]?.[0] as string).toContain(
			'nextPageToken=tok-2',
		);
	});

	it('advances startAt until total is reached on Server/DC', async () => {
		const fetchMock = vi
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					issues: [{ key: 'A-1', fields: {} }],
					total: 2,
				}),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					issues: [{ key: 'A-2', fields: {} }],
					total: 2,
				}),
			} as Response);

		const issues = await searchAllIssues<{ key: string }>(serverConfig, {
			jql: 'project = A',
			fields: 'key',
			maxResults: 1,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(issues.map((i) => i.key)).toEqual(['A-1', 'A-2']);
		expect(fetchMock.mock.calls[1]?.[0] as string).toContain('startAt=1');
	});

	it('throws an AbortError when the signal is already aborted (no partial as complete)', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.spyOn(global, 'fetch');

		await expect(
			searchAllIssues(
				cloudConfig,
				{ jql: 'x', fields: 'key', maxResults: 10 },
				{ signal: controller.signal },
			),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('throws an AbortError when aborted between pages on Cloud', async () => {
		const controller = new AbortController();
		const fetchMock = vi.spyOn(global, 'fetch').mockImplementationOnce(
			async () =>
				({
					ok: true,
					json: async () => ({
						issues: [{ key: 'A-1', fields: {} }],
						nextPageToken: 'tok-2',
					}),
				}) as Response,
		);

		await expect(
			searchAllIssues<{ key: string }>(
				cloudConfig,
				{ jql: 'project = A', fields: 'key', maxResults: 1 },
				{
					signal: controller.signal,
					// Abort after the first page has been gathered.
					onPage: () => controller.abort(),
				},
			),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('keeps paging on Server/DC when total is missing (does not stop after page 1)', async () => {
		const fetchMock = vi
			.spyOn(global, 'fetch')
			// First page: full (== maxResults), NO total field at all.
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					issues: [{ key: 'A-1', fields: {} }],
				}),
			} as Response)
			// Second page: still full, NO total.
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					issues: [{ key: 'A-2', fields: {} }],
				}),
			} as Response)
			// Third page: short → end.
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					issues: [],
				}),
			} as Response);

		const issues = await searchAllIssues<{ key: string }>(serverConfig, {
			jql: 'project = A',
			fields: 'key',
			maxResults: 1,
		});

		// Without the fix this would stop after page 1 (total defaults to 0).
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(issues.map((i) => i.key)).toEqual(['A-1', 'A-2']);
	});

	it('stops on a short page even when total is missing', async () => {
		const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				// Only 1 issue but maxResults is 5 → short page, end of results.
				issues: [{ key: 'A-1', fields: {} }],
			}),
		} as Response);

		const issues = await searchAllIssues<{ key: string }>(serverConfig, {
			jql: 'project = A',
			fields: 'key',
			maxResults: 5,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(issues.map((i) => i.key)).toEqual(['A-1']);
	});
});
