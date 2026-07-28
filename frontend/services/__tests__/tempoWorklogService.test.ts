import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bridge from '../proxyUrlBridge';
import { __resetIdentityCache } from '../jiraIdentity';
import { fetchMonthWorklogsTempo } from '../tempoWorklogService';

const config = {
	jiraHost: 'x.atlassian.net',
	email: 'me@x.com',
	apiToken: 't',
	corsProxy: '',
	tempoApiToken: 'tempo-tok',
};

afterEach(() => {
	vi.restoreAllMocks();
	__resetIdentityCache();
});

function routeFetch(handlers: {
	myself?: object;
	tempo?: object;
	jiraSearch?: object;
	jiraUser?: object;
}) {
	vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
		hostedProxyUrl: null,
		userOverride: false,
		supabaseAccessToken: null,
	});
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (url.includes('/myself'))
				return new Response(
					JSON.stringify(handlers.myself ?? { accountId: 'acc-1' }),
					{ status: 200 },
				);
			if (url.includes('api.tempo.io'))
				return new Response(JSON.stringify(handlers.tempo), { status: 200 });
			if (url.includes('/search/jql'))
				return new Response(JSON.stringify(handlers.jiraSearch), {
					status: 200,
				});
			if (url.includes('/rest/api/3/user'))
				return new Response(JSON.stringify(handlers.jiraUser ?? {}), {
					status: 200,
				});
			throw new Error(`unexpected url ${url}`);
		}),
	);
}

describe('fetchMonthWorklogsTempo', () => {
	it('returns Tempo worklogs (authored by the Tempo app) enriched with Jira issue metadata', async () => {
		routeFetch({
			tempo: {
				results: [
					{
						tempoWorklogId: 55,
						issue: { id: 1001 },
						timeSpentSeconds: 3600,
						startDate: '2026-06-05',
						startTime: '08:00:00',
						description: 'work',
						author: { accountId: 'acc-1' },
					},
				],
				metadata: {},
			},
			jiraSearch: {
				issues: [{ id: '1001', key: 'PAY-1', fields: { summary: 'Do thing' } }],
				isLast: true,
			},
		});
		const out = await fetchMonthWorklogsTempo(config, 2026, 5, undefined); // month is 0-indexed → June
		expect(out).toHaveLength(1);
		expect(out[0].issue.key).toBe('PAY-1');
		expect(out[0].timeSpentSeconds).toBe(3600);
	});

	it('follows metadata.next pagination', async () => {
		let page = 0;
		vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
			hostedProxyUrl: null,
			userOverride: false,
			supabaseAccessToken: null,
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url.includes('/myself'))
					return new Response(JSON.stringify({ accountId: 'acc-1' }), {
						status: 200,
					});
				if (url.includes('api.tempo.io')) {
					page += 1;
					return page === 1
						? new Response(
								JSON.stringify({
									results: [
										{
											tempoWorklogId: 1,
											issue: { id: 1001 },
											timeSpentSeconds: 60,
											startDate: '2026-06-05',
										},
									],
									metadata: {
										next: 'https://api.tempo.io/4/worklogs/user/acc-1?offset=50',
									},
								}),
								{ status: 200 },
							)
						: new Response(
								JSON.stringify({
									results: [
										{
											tempoWorklogId: 2,
											issue: { id: 1001 },
											timeSpentSeconds: 60,
											startDate: '2026-06-06',
										},
									],
									metadata: {},
								}),
								{ status: 200 },
							);
				}
				if (url.includes('/search/jql'))
					return new Response(
						JSON.stringify({
							issues: [{ id: '1001', key: 'PAY-1', fields: {} }],
							isLast: true,
						}),
						{ status: 200 },
					);
				throw new Error(url);
			}),
		);
		const out = await fetchMonthWorklogsTempo(config, 2026, 5, undefined);
		expect(out).toHaveLength(2);
	});

	it('throws when the Tempo fetch fails (no silent undercount)', async () => {
		vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
			hostedProxyUrl: null,
			userOverride: false,
			supabaseAccessToken: null,
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url.includes('/myself'))
					return new Response(JSON.stringify({ accountId: 'acc-1' }), {
						status: 200,
					});
				return new Response('boom', { status: 500 });
			}),
		);
		await expect(
			fetchMonthWorklogsTempo(config, 2026, 5, undefined),
		).rejects.toMatchObject({ kind: 'server-error' });
	});

	it('team-wide fetch uses GET /4/worklogs (no user scope) and resolves authors', async () => {
		routeFetch({
			tempo: {
				results: [
					{
						tempoWorklogId: 100,
						issue: { id: 2001 },
						timeSpentSeconds: 7200,
						startDate: '2026-06-10',
						startTime: '09:00:00',
						description: 'team work',
						author: { accountId: 'acc-alice' },
					},
					{
						tempoWorklogId: 101,
						issue: { id: 2001 },
						timeSpentSeconds: 3600,
						startDate: '2026-06-10',
						startTime: '14:00:00',
						description: 'more team work',
						author: { accountId: 'acc-bob' },
					},
				],
				metadata: {},
			},
			jiraSearch: {
				issues: [{ id: '2001', key: 'TEAM-1', fields: { summary: 'Team task' } }],
				isLast: true,
			},
			jiraUser: { accountId: 'acc-alice', emailAddress: 'alice@x.com', displayName: 'Alice' },
		});

		// Override fetch to return different users for different accountIds
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes('/myself'))
				return new Response(JSON.stringify({ accountId: 'acc-1' }), { status: 200 });
			if (url.includes('api.tempo.io'))
				return new Response(JSON.stringify({
					results: [
						{
							tempoWorklogId: 100,
							issue: { id: 2001 },
							timeSpentSeconds: 7200,
							startDate: '2026-06-10',
							startTime: '09:00:00',
							description: 'team work',
							author: { accountId: 'acc-alice' },
						},
						{
							tempoWorklogId: 101,
							issue: { id: 2001 },
							timeSpentSeconds: 3600,
							startDate: '2026-06-10',
							startTime: '14:00:00',
							description: 'more team work',
							author: { accountId: 'acc-bob' },
						},
					],
					metadata: {},
				}), { status: 200 });
			if (url.includes('/search/jql'))
				return new Response(JSON.stringify({
					issues: [{ id: '2001', key: 'TEAM-1', fields: { summary: 'Team task' } }],
					isLast: true,
				}), { status: 200 });
			if (url.includes('/rest/api/3/user') && url.includes('acc-alice'))
				return new Response(JSON.stringify({
					accountId: 'acc-alice',
					emailAddress: 'alice@x.com',
					displayName: 'Alice',
				}), { status: 200 });
			if (url.includes('/rest/api/3/user') && url.includes('acc-bob'))
				return new Response(JSON.stringify({
					accountId: 'acc-bob',
					emailAddress: 'bob@x.com',
					displayName: 'Bob',
				}), { status: 200 });
			throw new Error(`unexpected url ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const out = await fetchMonthWorklogsTempo(config, 2026, 5, { currentUserOnly: false });
		expect(out).toHaveLength(2);

		// Verify the Tempo call used the team-wide endpoint (no /user/ in path)
		const tempoCall = fetchMock.mock.calls.find(
			(args: unknown[]) => (args[0] as string).includes('api.tempo.io'),
		);
		expect(tempoCall).toBeDefined();
		expect((tempoCall![0] as string)).not.toContain('/user/');

		// Verify authors are resolved per-worklog
		expect(out[0].author?.emailAddress).toBe('alice@x.com');
		expect(out[0].author?.displayName).toBe('Alice');
		expect(out[1].author?.emailAddress).toBe('bob@x.com');
		expect(out[1].author?.displayName).toBe('Bob');
	});
});
