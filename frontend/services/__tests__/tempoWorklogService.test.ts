import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetIdentityCache } from '../jiraIdentity';
import * as bridge from '../proxyUrlBridge';
import {
	fetchMonthWorklogsTempo,
	fetchTeamMonthWorklogsTempo,
} from '../tempoWorklogService';

const config = {
	jiraHost: 'x.atlassian.net',
	email: 'me@x.com',
	apiToken: 't',
	// Tempo is unreachable from a browser without a proxy, so every realistic
	// self-hosted config has one.
	corsProxy: 'https://proxy.example',
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
});

describe('fetchTeamMonthWorklogsTempo (ADA-545)', () => {
	/**
	 * Records every URL fetched so the tests can assert which Tempo endpoint was
	 * used — the per-user endpoint silently collapses a team read to one person.
	 */
	function routeTeamFetch(tempoPage: object, extra: { bulk?: object } = {}) {
		const urls: string[] = [];
		vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
			hostedProxyUrl: null,
			userOverride: false,
			supabaseAccessToken: null,
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				urls.push(url);
				if (url.includes('/user/bulk'))
					return new Response(JSON.stringify(extra.bulk ?? { values: [] }), {
						status: 200,
					});
				if (url.includes('/myself'))
					return new Response(JSON.stringify({ accountId: 'acc-me' }), {
						status: 200,
					});
				if (url.includes('api.tempo.io'))
					return new Response(JSON.stringify(tempoPage), { status: 200 });
				if (url.includes('/search/jql'))
					return new Response(JSON.stringify({ issues: [] }), { status: 200 });
				throw new Error(`unexpected url ${url}`);
			}),
		);
		return urls;
	}

	const twoAuthors = {
		results: [
			{
				tempoWorklogId: 1,
				issue: { id: 1001 },
				timeSpentSeconds: 3600,
				startDate: '2026-07-06',
				startTime: '09:00:00',
				createdAt: '2026-07-06T09:00:00Z',
				author: { accountId: 'acc-alice' },
			},
			{
				tempoWorklogId: 2,
				issue: { id: 1001 },
				timeSpentSeconds: 7200,
				startDate: '2026-07-07',
				startTime: '09:00:00',
				createdAt: '2026-07-07T09:00:00Z',
				author: { accountId: 'acc-bob' },
			},
		],
	};

	it('uses the non-user-scoped endpoint so teammates are not filtered out', async () => {
		const urls = routeTeamFetch(twoAuthors);
		await fetchTeamMonthWorklogsTempo(config, 2026, 6);
		const tempoUrls = urls.filter((u) => u.includes('api.tempo.io'));
		expect(tempoUrls.length).toBeGreaterThan(0);
		for (const url of tempoUrls) {
			expect(url).not.toContain('/worklogs/user/');
		}
		expect(tempoUrls[0]).toContain('/worklogs?');
	});

	it('returns every author, not just the signed-in user', async () => {
		routeTeamFetch(twoAuthors);
		const out = await fetchTeamMonthWorklogsTempo(config, 2026, 6);
		expect(out).toHaveLength(2);
	});

	it('attributes each worklog to its own author, never the signed-in user', async () => {
		routeTeamFetch(twoAuthors, {
			bulk: {
				values: [
					{ accountId: 'acc-alice', emailAddress: 'alice@x.com' },
					{ accountId: 'acc-bob', emailAddress: 'bob@x.com' },
				],
			},
		});
		const out = await fetchTeamMonthWorklogsTempo(config, 2026, 6);
		const emails = out.map((w) => w.author?.emailAddress).sort();
		// The per-user mapper stamps config.email on every row; for a team read
		// that would collapse the whole team into one person in the completeness
		// table, which groups by email.
		expect(emails).toEqual(['alice@x.com', 'bob@x.com']);
	});

	it('falls back to the accountId when Jira exposes no email for a user', async () => {
		routeTeamFetch(twoAuthors, {
			bulk: {
				values: [{ accountId: 'acc-alice', emailAddress: 'alice@x.com' }],
			},
		});
		const out = await fetchTeamMonthWorklogsTempo(config, 2026, 6);
		const bob = out.find((w) => w.author?.accountId === 'acc-bob');
		expect(bob?.author?.emailAddress).toBe('acc-bob');
	});
});

describe('user JQL filter on the Tempo read path', () => {
	const twoIssues = {
		results: [
			{
				tempoWorklogId: 1,
				issue: { id: 1001 },
				timeSpentSeconds: 3600,
				startDate: '2026-07-06',
				startTime: '09:00:00',
				createdAt: '2026-07-06T09:00:00Z',
				author: { accountId: 'acc-1' },
			},
			{
				tempoWorklogId: 2,
				issue: { id: 2002 },
				timeSpentSeconds: 3600,
				startDate: '2026-07-07',
				startTime: '09:00:00',
				createdAt: '2026-07-07T09:00:00Z',
				author: { accountId: 'acc-1' },
			},
		],
	};

	// Jira returns only the issue that satisfies the filter.
	const onlyFirstMatches = {
		issues: [{ id: '1001', key: 'PAY-1', fields: { summary: 'kept' } }],
	};

	it('drops worklogs whose issue the filter excluded', async () => {
		routeFetch({ tempo: twoIssues, jiraSearch: onlyFirstMatches });
		const out = await fetchMonthWorklogsTempo(
			config as never,
			2026,
			6,
			undefined,
			'project = PAY',
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.issue.key).toBe('PAY-1');
	});

	it('keeps worklogs with a placeholder when no filter is configured', async () => {
		routeFetch({ tempo: twoIssues, jiraSearch: onlyFirstMatches });
		const out = await fetchMonthWorklogsTempo(config as never, 2026, 6);
		// Without a filter, a missing issue means Jira metadata was unavailable —
		// dropping the worklog there would silently undercount real hours.
		expect(out).toHaveLength(2);
	});
});

describe('real display names reach Reports (ADA-545)', () => {
	function routeWithBulk(tempoPage: object, bulk: object) {
		vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
			hostedProxyUrl: null,
			userOverride: false,
			supabaseAccessToken: null,
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url.includes('/user/bulk'))
					return new Response(JSON.stringify(bulk), { status: 200 });
				if (url.includes('/myself'))
					return new Response(
						JSON.stringify({
							accountId: 'acc-me',
							displayName: 'Me Myself',
						}),
						{ status: 200 },
					);
				if (url.includes('api.tempo.io'))
					return new Response(JSON.stringify(tempoPage), { status: 200 });
				if (url.includes('/search/jql'))
					return new Response(
						JSON.stringify({
							issues: [{ id: '1001', key: 'PAY-1', fields: { summary: 's' } }],
						}),
						{ status: 200 },
					);
				throw new Error(`unexpected url ${url}`);
			}),
		);
	}

	const page = {
		results: [
			{
				tempoWorklogId: 1,
				issue: { id: 1001 },
				timeSpentSeconds: 3600,
				startDate: '2026-07-06',
				startTime: '09:00:00',
				createdAt: '2026-07-06T09:00:00Z',
				author: { accountId: 'acc-alice' },
			},
		],
	};

	it('uses each teammate real display name from Jira', async () => {
		routeWithBulk(page, {
			values: [
				{
					accountId: 'acc-alice',
					emailAddress: 'alice@x.com',
					displayName: 'Alice Alpha',
				},
			],
		});
		const out = await fetchTeamMonthWorklogsTempo(config as never, 2026, 6);
		expect(out[0]?.author?.displayName).toBe('Alice Alpha');
	});

	it('uses the signed-in user display name for a personal read', async () => {
		routeWithBulk(page, { values: [] });
		const out = await fetchMonthWorklogsTempo(config as never, 2026, 6);
		expect(out[0]?.author?.displayName).toBe('Me Myself');
	});
});

describe('jqlFilter comes from the caller, not the saved config (review #9)', () => {
	function captureJql(tempoPage: object) {
		const urls: string[] = [];
		vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
			hostedProxyUrl: null,
			userOverride: false,
			supabaseAccessToken: null,
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				urls.push(url);
				if (url.includes('/user/bulk'))
					return new Response(JSON.stringify({ values: [] }), { status: 200 });
				if (url.includes('/myself'))
					return new Response(JSON.stringify({ accountId: 'acc-me' }), {
						status: 200,
					});
				if (url.includes('api.tempo.io'))
					return new Response(JSON.stringify(tempoPage), { status: 200 });
				return new Response(JSON.stringify({ issues: [] }), { status: 200 });
			}),
		);
		return urls;
	}

	const page = {
		results: [
			{
				tempoWorklogId: 1,
				issue: { id: 1001 },
				timeSpentSeconds: 3600,
				startDate: '2026-07-06',
				startTime: '09:00:00',
				createdAt: '2026-07-06T09:00:00Z',
				author: { accountId: 'acc-1' },
			},
		],
	};

	const withSavedFilter = { ...config, jqlFilter: 'project = SAVED' };

	it('applies no filter when the caller passes none', async () => {
		// Reports deliberately reads unfiltered and builds its cache key with an
		// empty filter. Applying the saved filter anyway makes the key a lie:
		// the rows are filtered, and editing the filter in Settings does not
		// invalidate the entry.
		const urls = captureJql(page);
		await fetchTeamMonthWorklogsTempo(withSavedFilter as never, 2026, 6);
		const search = urls.find((u) => u.includes('search/jql')) ?? '';
		expect(decodeURIComponent(search)).not.toContain('SAVED');
	});

	it('applies the filter the caller passes', async () => {
		const urls = captureJql(page);
		await fetchTeamMonthWorklogsTempo(
			withSavedFilter as never,
			2026,
			6,
			undefined,
			'project = ASKED',
		);
		const search = urls.find((u) => u.includes('search/jql')) ?? '';
		expect(decodeURIComponent(search)).toContain('ASKED');
	});
});
