import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildGithubApiBase,
	fetchGithubSuggestions,
	fetchGithubUser,
} from '../githubService';

function jsonRes(body: unknown, status = 200): Response {
	return { ok: status < 400, status, json: async () => body } as Response;
}

afterEach(() => vi.restoreAllMocks());

describe('buildGithubApiBase', () => {
	it('uses api.github.com directly when no host/proxy', () => {
		expect(buildGithubApiBase('', '')).toBe('https://api.github.com');
	});
	it('uses GHES /api/v3 when a host is set', () => {
		expect(buildGithubApiBase('github.acme.com', '')).toBe(
			'https://github.acme.com/api/v3',
		);
	});
	it('prefixes the CORS proxy when given (GHES path)', () => {
		expect(buildGithubApiBase('github.acme.com', 'http://localhost:8081')).toBe(
			'http://localhost:8081/https://github.acme.com/api/v3',
		);
	});
});

describe('fetchGithubUser', () => {
	it('returns login + name and sends a Bearer token', async () => {
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(jsonRes({ login: 'me', name: 'Me' }));
		const u = await fetchGithubUser('tok', '', '');
		expect(u).toEqual({ login: 'me', name: 'Me' });
		const [, init] = spy.mock.calls[0];
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			'Bearer tok',
		);
	});
});

describe('fetchGithubSuggestions', () => {
	it('builds suggestions from a PushEvent with a Jira key in the branch', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonRes({ login: 'me', name: 'Me' })) // /user
			.mockResolvedValueOnce(
				jsonRes([
					{
						type: 'PushEvent',
						created_at: '2026-06-16T10:00:00Z',
						payload: {
							ref: 'refs/heads/feature/PUMA-12-login',
							commits: [{ message: 'wip' }, { message: 'more wip' }],
						},
					},
				]),
			)
			.mockResolvedValueOnce(jsonRes([])); // page 2 (empty → stop)

		const out = await fetchGithubSuggestions(
			'tok',
			'',
			'',
			'2026-06-15',
			'2026-06-21',
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			source: 'github',
			issueKey: 'PUMA-12',
			date: '2026-06-16',
		});
		expect(out[0].id).toBe('github-PUMA-12-2026-06-16');
	});

	it('captures a review comment on someone else PR via the PR title key', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonRes({ login: 'me', name: 'Me' }))
			.mockResolvedValueOnce(
				jsonRes([
					{
						type: 'PullRequestReviewCommentEvent',
						created_at: '2026-06-17T09:00:00Z',
						payload: {
							pull_request: { title: 'PUMA-99 fix race' },
							comment: { body: 'nit: rename this' },
						},
					},
				]),
			)
			.mockResolvedValueOnce(jsonRes([]));

		const out = await fetchGithubSuggestions(
			'tok',
			'',
			'',
			'2026-06-15',
			'2026-06-21',
		);
		expect(out).toHaveLength(1);
		expect(out[0].issueKey).toBe('PUMA-99');
		expect(out[0].reason).toMatch(/review\/comment/i);
	});

	it('captures a submitted review (PullRequestReviewEvent) via the PR title key', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonRes({ login: 'me', name: 'Me' }))
			.mockResolvedValueOnce(
				jsonRes([
					{
						type: 'PullRequestReviewEvent',
						created_at: '2026-06-17T09:00:00Z',
						payload: {
							action: 'submitted',
							pull_request: { title: 'PUMA-77 add cache' },
							review: { body: 'looks good' },
						},
					},
				]),
			)
			.mockResolvedValueOnce(jsonRes([]));

		const out = await fetchGithubSuggestions('tok', '', '', '2026-06-15', '2026-06-21');
		expect(out).toHaveLength(1);
		expect(out[0].issueKey).toBe('PUMA-77');
		expect(out[0].reason).toMatch(/review\/comment/i);
	});

	it('drops events with no Jira key and events outside the week', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonRes({ login: 'me', name: 'Me' }))
			.mockResolvedValueOnce(
				jsonRes([
					{
						type: 'PushEvent',
						created_at: '2026-06-16T10:00:00Z',
						payload: { ref: 'refs/heads/no-key', commits: [{ message: 'x' }] },
					},
					{
						type: 'PushEvent',
						created_at: '2026-06-30T10:00:00Z',
						payload: {
							ref: 'refs/heads/PUMA-1',
							commits: [{ message: 'x' }],
						},
					},
				]),
			)
			.mockResolvedValueOnce(jsonRes([]));

		const out = await fetchGithubSuggestions(
			'tok',
			'',
			'',
			'2026-06-15',
			'2026-06-21',
		);
		expect(out).toEqual([]);
	});

	it('returns [] without fetching when no token', async () => {
		const spy = vi.spyOn(globalThis, 'fetch');
		expect(
			await fetchGithubSuggestions('', '', '', '2026-06-15', '2026-06-21'),
		).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});
});
