/**
 * Unit tests for the RescueTime forward helper (ADA-466).
 *
 * The upstream host is fixed, so there's no SSRF surface to test (unlike
 * jiraForward). What matters here: the key from `apiKey` lands in the upstream
 * `key=` query param, a client-supplied `key` is ignored, query params are
 * forwarded, and upstream CORS headers are stripped in favour of ours.
 */

import { describe, expect, it } from 'vitest';
import { forwardToRescueTime } from '../rescueTimeForward';

const ALLOWED_ORIGIN = 'https://hoursmith.io';

function makeRequest(query: string, origin = ALLOWED_ORIGIN): Request {
	return new Request(`https://hoursmith.io/api/rescuetime?${query}`, {
		method: 'POST', // exercise that we always GET upstream regardless
		headers: { origin },
	});
}

function captureFetch(response: Response) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const impl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe('forwardToRescueTime', () => {
	it('appends the header key to the upstream query and forwards other params', async () => {
		const { impl, calls } = captureFetch(
			new Response(JSON.stringify({ rows: [] }), { status: 200 }),
		);

		await forwardToRescueTime({
			request: makeRequest('restrict_begin=2026-06-15&format=json'),
			apiKey: 'rt-secret',
			fetchImpl: impl,
		});

		const target = new URL(calls[0].url);
		expect(target.origin + target.pathname).toBe(
			'https://www.rescuetime.com/anapi/data',
		);
		expect(target.searchParams.get('key')).toBe('rt-secret');
		expect(target.searchParams.get('restrict_begin')).toBe('2026-06-15');
		// Always GET upstream, even though the incoming request was POST.
		expect((calls[0].init?.method ?? 'GET').toUpperCase()).toBe('GET');
	});

	it('ignores a client-supplied key in the query (header wins)', async () => {
		const { impl, calls } = captureFetch(new Response('{}', { status: 200 }));

		await forwardToRescueTime({
			request: makeRequest('key=attacker-supplied&format=json'),
			apiKey: 'rt-secret',
			fetchImpl: impl,
		});

		const target = new URL(calls[0].url);
		// Exactly one key, and it's the authenticated one.
		expect(target.searchParams.getAll('key')).toEqual(['rt-secret']);
	});

	it('defaults format=json when the client omits it', async () => {
		const { impl, calls } = captureFetch(new Response('{}', { status: 200 }));
		await forwardToRescueTime({
			request: makeRequest('restrict_begin=2026-06-15'),
			apiKey: 'rt-secret',
			fetchImpl: impl,
		});
		expect(new URL(calls[0].url).searchParams.get('format')).toBe('json');
	});

	it('strips upstream CORS headers and applies our own CORS layer', async () => {
		// Note: undici's Request constructor drops the forbidden `Origin` header,
		// so origin reflection (covered by cors.test.ts) can't be exercised here.
		// We instead assert the upstream wildcard is gone and our layer ran.
		const upstream = new Response(JSON.stringify({ rows: [] }), {
			status: 200,
			headers: {
				'access-control-allow-origin': '*', // upstream's — must be stripped
				'content-type': 'application/json',
			},
		});
		const { impl } = captureFetch(upstream);

		const res = await forwardToRescueTime({
			request: makeRequest('format=json'),
			apiKey: 'rt-secret',
			fetchImpl: impl,
		});

		// Upstream's permissive wildcard must never reach the browser.
		expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
		// Our CORS layer always sets `Vary: Origin` — proof it replaced upstream's.
		expect(res.headers.get('vary')).toBe('Origin');
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(res.status).toBe(200);
	});

	it('maps an upstream network failure to 502 without leaking detail', async () => {
		const impl = (async () => {
			throw new TypeError('getaddrinfo ENOTFOUND www.rescuetime.com');
		}) as unknown as typeof fetch;

		const res = await forwardToRescueTime({
			request: makeRequest('format=json'),
			apiKey: 'rt-secret',
			fetchImpl: impl,
		});

		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('upstream_error');
	});

	it('maps an aborted/timed-out upstream to 504', async () => {
		const impl = (async () => {
			const err = new Error('aborted');
			err.name = 'AbortError';
			throw err;
		}) as unknown as typeof fetch;

		const res = await forwardToRescueTime({
			request: makeRequest('format=json'),
			apiKey: 'rt-secret',
			fetchImpl: impl,
		});

		expect(res.status).toBe(504);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('upstream_timeout');
	});
});
