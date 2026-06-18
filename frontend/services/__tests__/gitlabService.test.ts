/**
 * Tests for the GitLab worklog-suggestion seam (ADA-465).
 *
 * Covers the verified integration bugs:
 *  - ServiceError / abort propagation (no re-wrapping that destroys diagnostics)
 *  - Jira key regex left boundary + single-letter project keys
 *  - exclusive `after`/`before` bounds widened so first/last day events survive
 *  - a push's commit_count counted once, not once per referenced key
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractJiraKeys, fetchGitlabSuggestions } from '../gitlabService';
import { ServiceError } from '../serviceErrors';

const HOST = 'gitlab.example.com';
const TOKEN = 'glpat-xxx';
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

afterEach(() => {
	vi.restoreAllMocks();
});

describe('extractJiraKeys', () => {
	it('matches standard Jira keys', () => {
		expect(extractJiraKeys('Fix PROJ-123 and ABC-9')).toEqual([
			'PROJ-123',
			'ABC-9',
		]);
	});

	it('does not extract a sub-key from inside a longer token (left boundary)', () => {
		// `XPROJ-5` must NOT yield the spurious sub-key `PROJ-5`; the left
		// boundary keeps the match anchored to the start of the token.
		expect(extractJiraKeys('XPROJ-5')).not.toContain('PROJ-5');
		expect(extractJiraKeys('XPROJ-5')).toEqual(['XPROJ-5']);
		expect(extractJiraKeys('feature/XPROJ-5-thing')).not.toContain('PROJ-5');
	});

	it('does not extract a key when preceded by a digit', () => {
		// `1ABC-5` should not yield `ABC-5` (digit is a left boundary char).
		expect(extractJiraKeys('1ABC-5')).not.toContain('ABC-5');
	});

	it('allows single-letter project keys', () => {
		expect(extractJiraKeys('branch A-1 done')).toEqual(['A-1']);
	});

	it('still matches a key after a non-alphanumeric boundary', () => {
		expect(extractJiraKeys('feature/ABC-12-login')).toEqual(['ABC-12']);
	});
});

describe('fetchGitlabSuggestions — error propagation', () => {
	it('keeps the ServiceError message and status on a 401 (no re-wrap)', async () => {
		mockFetchOnce(() => jsonResponse({ message: 'denied' }, 401));

		const err = await fetchGitlabSuggestions(
			TOKEN,
			HOST,
			'',
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

	it('propagates an AbortError as an abort, not a fake network error', async () => {
		mockFetchOnce(() => {
			throw new DOMException('aborted', 'AbortError');
		});

		const err = await fetchGitlabSuggestions(
			TOKEN,
			HOST,
			'',
			WEEK_START,
			WEEK_END,
		).catch((e) => e);

		expect(err).toBeInstanceOf(DOMException);
		expect((err as DOMException).name).toBe('AbortError');
		expect(err).not.toBeInstanceOf(ServiceError);
	});

	it('wraps a genuine network failure as a connection error', async () => {
		mockFetchOnce(() => {
			throw new TypeError('Failed to fetch');
		});

		const err = await fetchGitlabSuggestions(
			TOKEN,
			HOST,
			'',
			WEEK_START,
			WEEK_END,
		).catch((e) => e);

		expect(err).toBeInstanceOf(ServiceError);
		expect((err as ServiceError).message).toContain('Could not reach');
	});
});

describe('fetchGitlabSuggestions — exclusive bounds', () => {
	it('widens after/before by one day so first/last-day events are included', async () => {
		let capturedUrl = '';
		mockFetchOnce((url) => {
			capturedUrl = url;
			return jsonResponse([
				// An event on the very first day of the week.
				{
					action_name: 'pushed to',
					created_at: `${WEEK_START}T09:00:00Z`,
					push_data: {
						ref: 'feature/ABC-1',
						commit_title: 'ABC-1 work',
						commit_count: 1,
					},
				},
				// An event on the very last day of the week.
				{
					action_name: 'pushed to',
					created_at: `${WEEK_END}T17:00:00Z`,
					push_data: {
						ref: 'feature/ABC-2',
						commit_title: 'ABC-2 work',
						commit_count: 1,
					},
				},
			]);
		});

		const suggestions = await fetchGitlabSuggestions(
			TOKEN,
			HOST,
			'',
			WEEK_START,
			WEEK_END,
		);

		// Query bounds shifted outward by one day.
		expect(capturedUrl).toContain('after=2026-06-14');
		expect(capturedUrl).toContain('before=2026-06-22');

		const days = suggestions.map((s) => s.date).sort();
		expect(days).toEqual([WEEK_START, WEEK_END]);
	});

	it('still drops events outside the inclusive [weekStart, weekEnd] window', async () => {
		mockFetchOnce(() =>
			jsonResponse([
				{
					action_name: 'pushed to',
					// The day BEFORE the week — inside the widened query, outside the
					// inclusive client-side filter.
					created_at: '2026-06-14T23:00:00Z',
					push_data: {
						ref: 'feature/ABC-9',
						commit_title: 'ABC-9 early',
						commit_count: 1,
					},
				},
			]),
		);

		const suggestions = await fetchGitlabSuggestions(
			TOKEN,
			HOST,
			'',
			WEEK_START,
			WEEK_END,
		);

		expect(suggestions).toHaveLength(0);
	});
});

describe('fetchGitlabSuggestions — push commit attribution', () => {
	it('counts a multi-key push once, not once per key', async () => {
		mockFetchOnce(() =>
			jsonResponse([
				{
					action_name: 'pushed to',
					created_at: `${WEEK_START}T10:00:00Z`,
					push_data: {
						ref: 'feature/ABC-1',
						commit_title: 'ABC-1 ABC-2 combined work',
						commit_count: 4,
					},
				},
			]),
		);

		const suggestions = await fetchGitlabSuggestions(
			TOKEN,
			HOST,
			'',
			WEEK_START,
			WEEK_END,
		);

		// 4 commits split across 2 keys = 2 each. Without the fix both keys would
		// get 4 commits (double count). per push commit = 3600s, so 2 commits =
		// 7200s per key, 14400s total.
		const totalSeconds = suggestions.reduce(
			(acc, s) => acc + s.suggestedSeconds,
			0,
		);
		expect(suggestions).toHaveLength(2);
		expect(totalSeconds).toBe(4 * 3600);
		for (const s of suggestions) {
			expect(s.suggestedSeconds).toBe(2 * 3600);
		}
	});

	it('distributes the remainder so the total equals commit_count', async () => {
		mockFetchOnce(() =>
			jsonResponse([
				{
					action_name: 'pushed to',
					created_at: `${WEEK_START}T10:00:00Z`,
					push_data: {
						ref: 'feature/ABC-1',
						commit_title: 'ABC-1 ABC-2 ABC-3 work',
						commit_count: 4,
					},
				},
			]),
		);

		const suggestions = await fetchGitlabSuggestions(
			TOKEN,
			HOST,
			'',
			WEEK_START,
			WEEK_END,
		);

		// 4 commits across 3 keys: 2 + 1 + 1 = 4.
		const totalSeconds = suggestions.reduce(
			(acc, s) => acc + s.suggestedSeconds,
			0,
		);
		expect(suggestions).toHaveLength(3);
		expect(totalSeconds).toBe(4 * 3600);
	});
});
