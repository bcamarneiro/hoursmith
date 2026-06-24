// frontend/services/__tests__/devActivityService.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../../stores/useConfigStore';
import { fetchDevActivitySuggestions } from '../devActivityService';
import * as jiraSearch from '../jiraSearch';

const config = {
	...createDefaultConfig(),
	jiraHost: 'acme.atlassian.net',
	email: 'me@acme.com',
	apiToken: 'tok',
};

function devDetail(commits: unknown[]) {
	return {
		detail: [{ repositories: [{ name: 'puma/api', commits }] }],
	};
}

afterEach(() => vi.restoreAllMocks());

describe('fetchDevActivitySuggestions', () => {
	it('attributes the current user commits in the window to the issue', async () => {
		vi.spyOn(jiraSearch, 'fetchSearchPage').mockResolvedValue({
			issues: [{ id: '10001', key: 'PUMA-12', fields: { summary: 'Login' } }],
			total: 1,
		} as never);

		vi.spyOn(globalThis, 'fetch')
			// summary → has commits
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					summary: { repository: { overall: { count: 2 } } },
				}),
			} as Response)
			// detail (repository)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () =>
					devDetail([
						{
							displayId: 'abc123',
							message: 'fix login',
							authorTimestamp: '2026-06-16T10:00:00Z',
							author: { name: 'Me' },
						},
						{
							displayId: 'def456',
							message: 'teammate work',
							authorTimestamp: '2026-06-16T11:00:00Z',
							author: { name: 'Someone Else' },
						},
					]),
			} as Response);

		const out = await fetchDevActivitySuggestions(
			config,
			'2026-06-15',
			'2026-06-21',
			{ displayName: 'Me' },
		);

		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			source: 'github',
			issueKey: 'PUMA-12',
			date: '2026-06-16',
		});
		// Only the user's own commit counted (1), not the teammate's.
		expect(out[0].suggestedSeconds).toBe(3600);
	});

	it('returns [] (not error) when an issue has no dev data', async () => {
		vi.spyOn(jiraSearch, 'fetchSearchPage').mockResolvedValue({
			issues: [{ id: '10002', key: 'PUMA-13', fields: {} }],
			total: 1,
		} as never);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ summary: {} }),
		} as Response);

		const out = await fetchDevActivitySuggestions(
			config,
			'2026-06-15',
			'2026-06-21',
			{ displayName: 'Me' },
		);
		expect(out).toEqual([]);
	});

	it('isolates a per-issue detail failure (one bad issue does not sink the batch)', async () => {
		vi.spyOn(jiraSearch, 'fetchSearchPage').mockResolvedValue({
			issues: [
				{ id: '1', key: 'PUMA-1', fields: {} },
				{ id: '2', key: 'PUMA-2', fields: {} },
			],
			total: 2,
		} as never);
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					summary: { repository: { overall: { count: 1 } } },
				}),
			} as Response)
			.mockRejectedValueOnce(new Error('boom')) // detail for PUMA-1 fails
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ summary: {} }),
			} as Response); // PUMA-2 summary empty

		const out = await fetchDevActivitySuggestions(
			config,
			'2026-06-15',
			'2026-06-21',
			{ displayName: 'Me' },
		);
		expect(out).toEqual([]); // no throw
	});

	it('returns [] without calling Jira when host/token missing', async () => {
		const spy = vi.spyOn(jiraSearch, 'fetchSearchPage');
		const out = await fetchDevActivitySuggestions(
			{ ...config, apiToken: '' },
			'2026-06-15',
			'2026-06-21',
			{},
		);
		expect(out).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});
});
