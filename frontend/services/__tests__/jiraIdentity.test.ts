import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetIdentityCache, resolveAccountId } from '../jiraIdentity';

const cfg = {
	jiraHost: 'x.atlassian.net',
	email: 'me@x.com',
	apiToken: 't',
	corsProxy: '',
};

afterEach(() => {
	vi.restoreAllMocks();
	__resetIdentityCache();
});

describe('resolveAccountId', () => {
	it('returns the accountId from /myself', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ accountId: 'acc-1' }), { status: 200 }),
			),
		);
		expect(await resolveAccountId(cfg)).toBe('acc-1');
	});

	it('caches so a second call makes no request', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ accountId: 'acc-1' }), { status: 200 }),
		);
		vi.stubGlobal('fetch', fetchMock);
		await resolveAccountId(cfg);
		await resolveAccountId(cfg);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('throws a ServiceError on a 401', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('no', { status: 401 })),
		);
		await expect(resolveAccountId(cfg)).rejects.toMatchObject({
			kind: 'unauthorized',
		});
	});
});
