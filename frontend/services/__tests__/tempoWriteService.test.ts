import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetIdentityCache } from '../jiraIdentity';
import * as bridge from '../proxyUrlBridge';
import {
	createWorklogTempo,
	deleteWorklogTempo,
	getWorklogTempo,
	updateWorklogTempo,
} from '../tempoWriteService';

const config = {
	jiraHost: 'x.atlassian.net',
	email: 'me@x.com',
	apiToken: 't',
	corsProxy: 'https://proxy.example',
	tempoApiToken: 'tempo-tok',
};

afterEach(() => {
	vi.restoreAllMocks();
	__resetIdentityCache();
});

interface Captured {
	url: string;
	method?: string;
	body?: unknown;
}

/** Capture the outgoing request so tests assert on the wire, not on a mock. */
function captureFetch(responses: Record<string, unknown> = {}) {
	const calls: Captured[] = [];
	vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
		hostedProxyUrl: null,
		userOverride: false,
		supabaseAccessToken: null,
	});
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({
				url,
				method: init?.method,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (url.includes('/myself')) {
				return new Response(JSON.stringify({ accountId: 'acc-me' }), {
					status: 200,
				});
			}
			if (url.includes('/search/jql')) {
				return new Response(
					JSON.stringify(
						responses.jiraSearch ?? {
							issues: [{ id: '426364', key: 'PAY-1' }],
						},
					),
					{ status: 200 },
				);
			}
			return new Response(
				JSON.stringify(responses.tempo ?? { tempoWorklogId: 9 }),
				{
					status: 200,
				},
			);
		}),
	);
	return calls;
}

describe('createWorklogTempo', () => {
	it('posts to the Tempo worklogs endpoint rather than Jira', async () => {
		const calls = captureFetch();
		await createWorklogTempo(config, {
			issueKey: 'PAY-1',
			timeSpentSeconds: 3600,
			startDate: '2026-07-27',
			startTime: '09:00:00',
			description: 'work',
		});
		const write = calls.find((c) => c.method === 'POST');
		expect(write?.url).toContain('api.tempo.io');
		expect(write?.url).toContain('worklogs');
		// Writing to Jira on a Tempo instance authors the worklog as the human,
		// making it invisible to the Tempo-app filter or double-counted on import.
		expect(write?.url).not.toContain('/rest/api/2/issue/');
	});

	it('sends the issue id, since Tempo v4 rejects an issue key', async () => {
		const calls = captureFetch();
		await createWorklogTempo(config, {
			issueKey: 'PAY-1',
			timeSpentSeconds: 3600,
			startDate: '2026-07-27',
			startTime: '09:00:00',
			description: 'work',
		});
		const body = calls.find((c) => c.method === 'POST')?.body as {
			issueId?: number;
		};
		expect(body?.issueId).toBe(426364);
	});

	it('attributes the worklog to the signed-in user', async () => {
		const calls = captureFetch();
		await createWorklogTempo(config, {
			issueKey: 'PAY-1',
			timeSpentSeconds: 3600,
			startDate: '2026-07-27',
			startTime: '09:00:00',
			description: 'work',
		});
		const body = calls.find((c) => c.method === 'POST')?.body as {
			authorAccountId?: string;
		};
		expect(body?.authorAccountId).toBe('acc-me');
	});

	it('fails loudly when the issue key cannot be resolved to an id', async () => {
		captureFetch({ jiraSearch: { issues: [] } });
		await expect(
			createWorklogTempo(config, {
				issueKey: 'NOPE-1',
				timeSpentSeconds: 3600,
				startDate: '2026-07-27',
				startTime: '09:00:00',
				description: 'work',
			}),
		).rejects.toThrow(/NOPE-1/);
	});
});

describe('updateWorklogTempo', () => {
	it('PUTs to the worklog id', async () => {
		const calls = captureFetch();
		await updateWorklogTempo(config, '491168', {
			issueKey: 'PAY-1',
			timeSpentSeconds: 7200,
			startDate: '2026-07-28',
			startTime: '10:00:00',
			description: 'edited',
		});
		const write = calls.find((c) => c.method === 'PUT');
		expect(write?.url).toContain('worklogs/491168');
		expect(
			(write?.body as { timeSpentSeconds?: number })?.timeSpentSeconds,
		).toBe(7200);
	});
});

describe('deleteWorklogTempo', () => {
	it('DELETEs the worklog id', async () => {
		const calls = captureFetch();
		await deleteWorklogTempo(config, '491168');
		const write = calls.find((c) => c.method === 'DELETE');
		expect(write?.url).toContain('worklogs/491168');
	});

	it('throws on a failed delete instead of reporting success', async () => {
		vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
			hostedProxyUrl: null,
			userOverride: false,
			supabaseAccessToken: null,
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 403 })),
		);
		await expect(deleteWorklogTempo(config, '491168')).rejects.toThrow();
	});
});

describe('getWorklogTempo', () => {
	it('reads the worklog from Tempo, not from Jira', async () => {
		const calls = captureFetch({
			tempo: {
				tempoWorklogId: 491168,
				issue: { id: 426364 },
				timeSpentSeconds: 5400,
				startDate: '2026-07-27',
				startTime: '09:00:00',
				description: 'work',
			},
		});
		await getWorklogTempo(config, '491168');
		const read = calls.find((c) => c.url.includes('worklogs/491168'));
		// The edit modal loads the current values before opening. Fetching a
		// Tempo worklog id from Jira's API cannot work — the ids are different
		// spaces — so editing failed at the first step with a generic toast.
		expect(read?.url).toContain('api.tempo.io');
		expect(read?.url).not.toContain('/rest/api/2/issue/');
	});

	it('returns the fields the edit form needs, in Jira vocabulary', async () => {
		captureFetch({
			tempo: {
				tempoWorklogId: 491168,
				issue: { id: 426364 },
				timeSpentSeconds: 5400,
				startDate: '2026-07-27',
				startTime: '09:00:00',
				startDateTimeUtc: '2026-07-27T08:00:00Z',
				description: 'fixed the thing',
			},
		});
		const out = await getWorklogTempo(config, '491168');
		expect(out.comment).toBe('fixed the thing');
		expect(out.started).toBe('2026-07-27T09:00:00+01:00');
		// The form edits a Jira-style duration string.
		expect(out.timeSpent).toBe('1h 30m');
	});
});

describe('updateWorklogTempo — authorship', () => {
	it('does not reassign a teammate worklog to the person editing it', async () => {
		const calls = captureFetch();
		await updateWorklogTempo(config, '491168', {
			issueKey: 'PAY-1',
			timeSpentSeconds: 7200,
			startDate: '2026-07-28',
			startTime: '10:00:00',
			description: 'edited',
		});
		const body = calls.find((c) => c.method === 'PUT')?.body as {
			authorAccountId?: string;
		};
		// Reports renders one grid per teammate and lets a lead edit any row.
		// Sending the signed-in accountId moves the worklog's authorship in
		// Tempo: the teammate's month silently loses the hours and the lead's
		// gains them. Jira's native PUT does not change the author either.
		expect(body?.authorAccountId).toBeUndefined();
	});

	it('keeps the original author when the caller knows it', async () => {
		const calls = captureFetch();
		await updateWorklogTempo(config, '491168', {
			issueKey: 'PAY-1',
			timeSpentSeconds: 7200,
			startDate: '2026-07-28',
			startTime: '10:00:00',
			description: 'edited',
			authorAccountId: 'acc-teammate',
		});
		const body = calls.find((c) => c.method === 'PUT')?.body as {
			authorAccountId?: string;
		};
		expect(body?.authorAccountId).toBe('acc-teammate');
	});
});
