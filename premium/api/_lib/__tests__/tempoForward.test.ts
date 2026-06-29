import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardToTempo } from '../tempoForward';

afterEach(() => vi.restoreAllMocks());

describe('forwardToTempo', () => {
	it('forwards GET to the upstream path with the tempo bearer token', async () => {
		const fetchMock = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ results: [] }), { status: 200 }),
		);
		vi.stubGlobal('fetch', fetchMock);
		const res = await forwardToTempo({
			path: 'worklogs/user/acc-1',
			search: 'from=2026-06-01',
			tempoToken: 'tok',
			method: 'GET',
		});
		expect(res.status).toBe(200);
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toBe(
			'https://api.tempo.io/4/worklogs/user/acc-1?from=2026-06-01',
		);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).authorization).toBe(
			'Bearer tok',
		);
	});

	it('maps an upstream network failure to 502', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('ENOTFOUND api.tempo.io');
			}),
		);
		const res = await forwardToTempo({
			path: 'worklogs',
			search: '',
			tempoToken: 'tok',
			method: 'GET',
		});
		expect(res.status).toBe(502);
	});

	it('rejects a path that escapes the /4/ namespace', async () => {
		const res = await forwardToTempo({
			path: '../secret',
			search: '',
			tempoToken: 'tok',
			method: 'GET',
		});
		expect(res.status).toBe(400);
	});
});
