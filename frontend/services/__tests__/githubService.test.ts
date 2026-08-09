/**
 * Tests for the GitHub commit-fetching service.
 *
 * Covers:
 *  - ServiceError / abort propagation (no re-wrapping that destroys diagnostics)
 *  - Jira key extraction from commit messages
 *  - Commit grouping by (date, issueKey)
 *  - Multi-key commit distribution
 *  - Confidence levels based on commit count
 *  - Pagination through multiple pages
 *  - Error responses (401, 403, 422, rate-limit, network failures)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractJiraKeys, fetchGithubSuggestions } from '../githubService';
import { ServiceError } from '../serviceErrors';

const TOKEN = 'ghp_xxx';
const EMAIL = 'user@example.com';
const WEEK_START = '2026-06-15';
const WEEK_END = '2026-06-21';

function mockFetchOnce(handler: (url: string, init?: RequestInit) => Response) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		async (input: any, init?: any) => handler(String(input), init),
	);
}

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

function makeCommit(opts: {
	sha?: string;
	message: string;
	email?: string;
	date?: string;
	repo?: string;
}): import('../githubService').GitHubCommitItem {
	const sha = opts.sha ?? crypto.randomUUID();
	const email = opts.email ?? EMAIL;
	const date = opts.date ?? `${WEEK_START}T10:00:00Z`;
	return {
		sha,
		commit: {
			message: opts.message,
			author: { name: 'Test User', email, date },
		},
		html_url: `https://github.com/commit/${sha}`,
		repository: opts.repo ? { full_name: opts.repo } : undefined,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('extractJiraKeys', () => {
	it('matches standard Jira keys in commit messages', () => {
		expect(extractJiraKeys('PROJ-123: Implement login page')).toEqual([
			'PROJ-123',
		]);
	});

	it('extracts multiple Jira keys', () => {
		expect(extractJiraKeys('Fix PROJ-123 and ABC-9')).toEqual([
			'PROJ-123',
			'ABC-9',
		]);
	});

	it('does not extract a sub-key from inside a longer token (left boundary)', () => {
		expect(extractJiraKeys('XPROJ-5')).not.toContain('PROJ-5');
		expect(extractJiraKeys('XPROJ-5')).toEqual(['XPROJ-5']);
	});

	it('does not extract a key when preceded by a digit', () => {
		expect(extractJiraKeys('1ABC-5')).not.toContain('ABC-5');
	});

	it('allows single-letter project keys', () => {
		expect(extractJiraKeys('A-1 done')).toEqual(['A-1']);
	});

	it('still matches a key after a non-alphanumeric boundary', () => {
		expect(extractJiraKeys('feature/ABC-12-login')).toEqual(['ABC-12']);
	});

	it('returns empty array when no Jira keys are present', () => {
		expect(extractJiraKeys('Just a regular commit message')).toEqual([]);
	});
});

describe('fetchGithubSuggestions — error propagation', () => {
	it('keeps the ServiceError message and status on a 401 (no re-wrap)', async () => {
		mockFetchOnce(() => jsonResponse({ message: 'Bad credentials' }, 401));

		const err = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		).catch((e) => e);

		expect(err).toBeInstanceOf(ServiceError);
		expect((err as ServiceError).status).toBe(401);
		expect((err as ServiceError).kind).toBe('unauthorized');
		expect((err as ServiceError).message).toContain('401');
		// Must NOT have been collapsed into the generic network message.
		expect((err as ServiceError).message).not.toContain('Could not reach');
	});

	it('describes a 403 with rate-limit detail', async () => {
		mockFetchOnce(() =>
			jsonResponse(
				{ message: 'API rate limit exceeded for user' },
				403,
			),
		);

		const err = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		).catch((e) => e);

		expect(err).toBeInstanceOf(ServiceError);
		expect((err as ServiceError).status).toBe(403);
		expect((err as ServiceError).message).toContain('rate limit');
	});

	it('propagates an AbortError as an abort, not a fake network error', async () => {
		mockFetchOnce(() => {
			throw new DOMException('aborted', 'AbortError');
		});

		const err = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		).catch((e) => e);

		expect(err).toBeInstanceOf(DOMException);
		expect((err as DOMException).name).toBe('AbortError');
		expect(err).not.toBeInstanceOf(ServiceError);
	});

	it('wraps a genuine network failure as a ServiceError', async () => {
		mockFetchOnce(() => {
			throw new TypeError('Failed to fetch');
		});

		const err = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		).catch((e) => e);

		expect(err).toBeInstanceOf(ServiceError);
		expect((err as ServiceError).kind).toBe('network');
		expect((err as ServiceError).message).toContain('GitHub network error');
	});
});

describe('fetchGithubSuggestions — query construction', () => {
	it('sends the correct search query with email and date range', async () => {
		let capturedUrl = '';
		mockFetchOnce((url) => {
			capturedUrl = url;
			return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
		});

		await fetchGithubSuggestions(TOKEN, EMAIL, WEEK_START, WEEK_END);

		expect(capturedUrl).toContain('author-email%3Auser%40example.com');
		expect(capturedUrl).toContain('committer-date%3A2026-06-15..2026-06-21');
	});

	it('sends the authorization and accept headers', async () => {
		let capturedHeaders: Record<string, string> = {};
		mockFetchOnce((_url, init) => {
			capturedHeaders = (init?.headers as Record<string, string>) ?? {};
			return jsonResponse({
				total_count: 0,
				incomplete_results: false,
				items: [],
			});
		});

		await fetchGithubSuggestions(TOKEN, EMAIL, WEEK_START, WEEK_END);

		expect(capturedHeaders['Authorization']).toBe(`Bearer ${TOKEN}`);
		expect(capturedHeaders['Accept']).toBe(
			'application/vnd.github.cloak-preview',
		);
	});

	it('returns empty array when no token is provided', async () => {
		const result = await fetchGithubSuggestions('', EMAIL, WEEK_START, WEEK_END);
		expect(result).toEqual([]);
	});

	it('returns empty array when no email is provided', async () => {
		const result = await fetchGithubSuggestions(TOKEN, '', WEEK_START, WEEK_END);
		expect(result).toEqual([]);
	});
});

describe('fetchGithubSuggestions — commit grouping and suggestions', () => {
	it('extracts Jira keys from commit messages and groups by (date, key)', async () => {
		mockFetchOnce(() =>
			jsonResponse({
				total_count: 2,
				incomplete_results: false,
				items: [
					makeCommit({ message: 'PROJ-123: Add login page', date: `${WEEK_START}T10:00:00Z`, repo: 'myorg/myapp' }),
					makeCommit({ message: 'PROJ-456: Fix bug', date: `${WEEK_START}T14:00:00Z`, repo: 'myorg/myapp' }),
				],
			}),
		);

		const suggestions = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		);

		expect(suggestions).toHaveLength(2);
		expect(suggestions.map((s) => s.issueKey).sort()).toEqual([
			'PROJ-123',
			'PROJ-456',
		]);
		for (const s of suggestions) {
			expect(s.source).toBe('github');
			expect(s.date).toBe(WEEK_START);
			expect(s.id).toContain('github-');
		}
	});

	it('groups multiple commits for the same (date, key) together', async () => {
		mockFetchOnce(() =>
			jsonResponse({
				total_count: 3,
				incomplete_results: false,
				items: [
					makeCommit({ message: 'PROJ-123: First commit', date: `${WEEK_START}T09:00:00Z`, repo: 'myorg/myapp' }),
					makeCommit({ message: 'PROJ-123: Second commit', date: `${WEEK_START}T10:00:00Z`, repo: 'myorg/myapp' }),
					makeCommit({ message: 'PROJ-123: Third commit', date: `${WEEK_START}T11:00:00Z`, repo: 'myorg/myapp' }),
				],
			}),
		);

		const suggestions = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		);

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].issueKey).toBe('PROJ-123');
		// 3 commits × 3600 = 10800, capped at 14400
		expect(suggestions[0].suggestedSeconds).toBe(10800);
		expect(suggestions[0].confidence).toBe('high');
	});

	it('ignores commits without Jira keys', async () => {
		mockFetchOnce(() =>
			jsonResponse({
				total_count: 2,
				incomplete_results: false,
				items: [
					makeCommit({ message: 'Fix typo in readme', date: `${WEEK_START}T10:00:00Z` }),
					makeCommit({ message: 'PROJ-123: Real work', date: `${WEEK_START}T14:00:00Z` }),
				],
			}),
		);

		const suggestions = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		);

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].issueKey).toBe('PROJ-123');
	});

	it('caps time at 4 hours per (date, key)', async () => {
		mockFetchOnce(() =>
			jsonResponse({
				total_count: 10,
				incomplete_results: false,
				items: Array.from({ length: 10 }, (_, i) =>
					makeCommit({
						message: 'PROJ-123: Commit ' + i,
						date: `${WEEK_START}T${String(8 + i).padStart(2, '0')}:00:00Z`,
					}),
				),
			}),
		);

		const suggestions = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		);

		expect(suggestions).toHaveLength(1);
		// 10 × 3600 = 36000, capped at 14400
		expect(suggestions[0].suggestedSeconds).toBe(4 * 3600);
	});

	it('sets confidence based on commit count', async () => {
		mockFetchOnce((url) => {
			// First page: 1 commit
			if (url.includes('page=1')) {
				return jsonResponse({
					total_count: 2,
					incomplete_results: false,
					items: [
						makeCommit({ message: 'PROJ-123: A single commit', date: `${WEEK_START}T10:00:00Z` }),
					],
				});
			}
			return jsonResponse({
				total_count: 2,
				incomplete_results: false,
				items: [],
			});
		});

		const suggestions = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		);

		expect(suggestions).toHaveLength(1);
		// 1 commit = medium
		expect(suggestions[0].confidence).toBe('medium');
	});
});

describe('fetchGithubSuggestions — multi-key commit distribution', () => {
	it('distributes a single commit equally across referenced keys', async () => {
		mockFetchOnce(() =>
			jsonResponse({
				total_count: 1,
				incomplete_results: false,
				items: [
					makeCommit({
						message: 'PROJ-123 PROJ-456: Combined work',
						date: `${WEEK_START}T10:00:00Z`,
					}),
				],
			}),
		);

		const suggestions = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		);

		// 1 commit distributed across 2 keys = 0.5 commits per key
		expect(suggestions).toHaveLength(2);
		// Each key gets 0.5 commit × 3600s = 1800s (floored at 30min)
		const totalSeconds = suggestions.reduce(
			(acc, s) => acc + s.suggestedSeconds,
			0,
		);
		expect(totalSeconds).toBe(2 * 1800);
		for (const s of suggestions) {
			expect(s.suggestedSeconds).toBe(1800);
			expect(s.suggestedTimeSpent).toBe('30m');
		}
	});
});

describe('fetchGithubSuggestions — pagination', () => {
	it('paginates through multiple pages when there are more results', async () => {
		let pageCount = 0;
		mockFetchOnce((url) => {
			pageCount++;
			const page = Number(new URLSearchParams(url.split('?')[1]).get('page')) || 1;
			const items =
				page === 1
					? Array.from({ length: 100 }, (_, i) =>
							makeCommit({
								sha: `sha1-${i}`,
								message: `PROJ-123: Commit ${i}`,
								date: `${WEEK_START}T${String(8 + (i % 10)).padStart(2, '0')}:00:00Z`,
							}),
						)
					: Array.from({ length: 50 }, (_, i) =>
							makeCommit({
								sha: `sha2-${i}`,
								message: `PROJ-123: Commit ${100 + i}`,
								date: `${WEEK_START}T${String(8 + (i % 10)).padStart(2, '0')}:00:00Z`,
							}),
						);
			return jsonResponse({
				total_count: 150,
				incomplete_results: false,
				items,
			});
		});

		const suggestions = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		);

		// All 150 commits are for PROJ-123 — grouped into 1 suggestion
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].suggestedSeconds).toBe(4 * 3600); // capped
		// URL was called at least twice
		expect(pageCount).toBeGreaterThanOrEqual(2);
	});
});

describe('fetchGithubSuggestions — empty results', () => {
	it('returns empty array when there are no matching commits', async () => {
		mockFetchOnce(() =>
			jsonResponse({
				total_count: 0,
				incomplete_results: false,
				items: [],
			}),
		);

		const suggestions = await fetchGithubSuggestions(
			TOKEN,
			EMAIL,
			WEEK_START,
			WEEK_END,
		);

		expect(suggestions).toEqual([]);
	});
});
