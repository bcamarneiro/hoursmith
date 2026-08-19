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

	it('rejects a double-encoded path traversal (%252e%252e bypasses naive check)', async () => {
		// %252e%252e → first decode → %2e%2e → second decode (by URL parser) → ../
		// isSafePath must decode before checking so this is caught as status 400.
		const res = await forwardToTempo({
			path: '%252e%252e/admin',
			search: '',
			tempoToken: 'tok',
			method: 'GET',
		});
		expect(res.status).toBe(400);
	});

	it('rejects a single-encoded path traversal (%2e%2e)', async () => {
		// %2e%2e → decoded → .. — must be caught before fetch normalises the URL.
		const res = await forwardToTempo({
			path: '%2e%2e/admin',
			search: '',
			tempoToken: 'tok',
			method: 'GET',
		});
		expect(res.status).toBe(400);
	});

	it('rejects a path with malformed percent-encoding without throwing', async () => {
		// A bare % is invalid percent-encoding; decodeURIComponent throws URIError.
		// isSafePath must return false rather than propagating the exception.
		const res = await forwardToTempo({
			path: '%',
			search: '',
			tempoToken: 'tok',
			method: 'GET',
		});
		expect(res.status).toBe(400);
	});
});

describe('forwardToTempo — null-body statuses', () => {
	it('relays a 204 instead of turning a successful delete into a 502', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 204 })),
		);
		const res = await forwardToTempo({
			path: 'worklogs/491168',
			search: '',
			tempoToken: 'tok',
			method: 'DELETE',
		});
		// `new Response(body, { status: 204 })` throws for any non-null body in
		// Node and the Edge runtime, and the throw was caught by the
		// upstream-failure handler — so Tempo's successful DELETE (which answers
		// 204) was reported as a failure while the worklog was in fact gone.
		//
		// Asserting on the body rather than only the status matters: the jsdom
		// test environment permits a body on a 204, so a status-only assertion
		// passes even with the bug present.
		expect(res.status).toBe(204);
		expect(res.body).toBeNull();
	});

	it('relays a 304 without a body', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 304 })),
		);
		const res = await forwardToTempo({
			path: 'worklogs',
			search: '',
			tempoToken: 'tok',
			method: 'GET',
		});
		expect(res.status).toBe(304);
		expect(res.body).toBeNull();
	});
});
