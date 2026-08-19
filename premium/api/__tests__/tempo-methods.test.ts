import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hosted relay's allowed-method gate.
 *
 * Plan 1 shipped reads only, so the handler answered anything but GET with 405.
 * Plan 2 (ADA-544) added Tempo writes, which means create / update / delete
 * reach this relay on the hosted Premium path. Leaving the gate at GET-only
 * would make writes work in direct and self-hosted mode and fail on Premium —
 * the tier people pay for.
 */

const forwardToTempo = vi.fn(
	async (_opts: Record<string, unknown>) => new Response('{}', { status: 200 }),
);
const getEntitlement = vi.fn(async () => ({
	ok: true as const,
	userId: 'user-1',
}));

vi.mock('../_lib/tempoForward.js', () => ({
	forwardToTempo: (opts: Record<string, unknown>) => forwardToTempo(opts),
}));
vi.mock('../_lib/entitlement.js', () => ({
	getEntitlement: () => getEntitlement(),
}));
vi.mock('../_lib/logProxy.js', () => ({ logProxy: () => {} }));

async function loadHandler() {
	const mod = await import('../tempo/index');
	return mod.default;
}

function request(method: string, body?: string): Request {
	return new Request('https://hoursmith.io/api/tempo?path=worklogs', {
		method,
		headers: {
			origin: 'https://hoursmith.io',
			authorization: 'Bearer supabase-jwt',
			'x-tempo-token': 'tempo-tok',
			...(body ? { 'content-type': 'application/json' } : {}),
		},
		body,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	forwardToTempo.mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('hosted Tempo relay — allowed methods', () => {
	it('still allows GET', async () => {
		const handler = await loadHandler();
		const res = await handler(request('GET'));
		expect(res.status).not.toBe(405);
	});

	it('allows POST so worklog creation works on Premium', async () => {
		const handler = await loadHandler();
		const res = await handler(request('POST', JSON.stringify({ issueId: 1 })));
		expect(res.status).not.toBe(405);
	});

	it('allows PUT so worklog edits work on Premium', async () => {
		const handler = await loadHandler();
		const res = await handler(request('PUT', JSON.stringify({ issueId: 1 })));
		expect(res.status).not.toBe(405);
	});

	it('allows DELETE so worklog deletion works on Premium', async () => {
		const handler = await loadHandler();
		const res = await handler(request('DELETE'));
		expect(res.status).not.toBe(405);
	});

	it('still rejects a method Tempo has no use for', async () => {
		const handler = await loadHandler();
		const res = await handler(request('PATCH'));
		expect(res.status).toBe(405);
	});

	it('forwards the caller method upstream rather than forcing GET', async () => {
		const handler = await loadHandler();
		await handler(request('DELETE'));
		expect(forwardToTempo).toHaveBeenCalledWith(
			expect.objectContaining({ method: 'DELETE' }),
		);
	});

	it('forwards the request body on a write', async () => {
		const handler = await loadHandler();
		const payload = JSON.stringify({ issueId: 426364, timeSpentSeconds: 3600 });
		await handler(request('POST', payload));
		expect(forwardToTempo).toHaveBeenCalledWith(
			expect.objectContaining({ body: payload }),
		);
	});
});

describe('hosted Tempo relay — browser reachability', () => {
	/**
	 * Both of these fail *in the browser* while the upstream call succeeds, so
	 * neither shows up in a server-side test of forwardToTempo. The relay is
	 * only useful if the browser is allowed to send the request and read the
	 * reply.
	 */

	it('puts CORS headers on the forwarded response', async () => {
		const handler = await loadHandler();
		const res = await handler(request('GET'));
		// The forwarded response previously carried only content-type, so a
		// perfectly good 200 was blocked by the browser. Asserting on
		// allow-methods proves the CORS set was copied onto it; origin
		// *reflection* against the allowlist is covered by cors.test.ts, and
		// cannot be asserted here because Node strips the forbidden `Origin`
		// header when constructing a Request.
		expect(res.headers.get('access-control-allow-methods')).toBeTruthy();
		expect(res.headers.get('vary')).toBe('Origin');
		// The upstream body must still come through unchanged.
		expect(res.status).toBe(200);
	});

	it('allows the x-tempo-token header in preflight', async () => {
		const handler = await loadHandler();
		const res = await handler(
			new Request('https://hoursmith.io/api/tempo?path=worklogs', {
				method: 'OPTIONS',
				headers: { origin: 'https://hoursmith.io' },
			}),
		);
		const allowed = res.headers.get('access-control-allow-headers') ?? '';
		// buildTempoRequest always sends x-tempo-token in hosted mode; if
		// preflight does not allow it the request never leaves the browser.
		expect(allowed.toLowerCase()).toContain('x-tempo-token');
	});
});
