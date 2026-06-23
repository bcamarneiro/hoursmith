# GitHub-driven worklog suggestions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub as a worklog-suggestion source for Hoursmith, using a hybrid of Jira's dev-status API (Jira→GitHub, robust to keyless commits) and the GitHub Events API (GitHub→Jira, captures your reviews/comments on others' PRs).

**Architecture:** Two new frontend services feed the existing `mergeSuggestions` pipeline exactly like the GitLab source. `githubService` calls `api.github.com` directly (CORS is open — no proxy). `devActivityService` calls Jira's `/rest/dev-status` through the existing Jira request path (reusing Jira auth + hosted/self-hosted proxy). A shared `jiraKeys.ts` util holds the Jira-key regex used by both GitLab and GitHub. No new server/Edge code.

**Tech Stack:** TypeScript, React, Zustand, Vitest, Biome. Spec: `docs/superpowers/specs/2026-06-23-github-dev-activity-worklogs-design.md`.

## Global Constraints

- Repo root for all paths: `/Users/brunocamarneiro/Projects/bcamarneiro/jira-timesheet-report`.
- Run tests with `npx vitest run <path>`; typecheck `npx tsc --noEmit`; lint/format `npx biome check --write <paths>`.
- Branch: `feat/github-dev-activity-worklogs` (already created). PRs target `main`. Required CI checks: `quality`, `e2e-smoke`.
- A pre-commit hook runs `biome format` automatically — commits may reformat; that's expected.
- NEVER put Claude/AI references or `Co-Authored-By` in commits or PRs (user global rule).
- github.com base is `https://api.github.com`, called **directly** (no CORS proxy). GitHub auth header: `Authorization: Bearer <token>`, plus `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
- GitHub Events ceiling: ≤300 events / 90 days; paginate `per_page=100`, max 5 pages.
- Time heuristics (mirror GitLab, in `gitlabService.ts:175-193`): push ≈3600s/commit cap 4h/day; PR action 1800s cap 2h/day; review/comment 900s cap 2h/day; overall 6h/day/issue cap.
- dev-status is **best-effort enrichment**: an empty result is success, never a surfaced error. Per-issue failures must be caught and skipped.
- The API key/token must never appear in log output or UI copy.

---

### Task 1: Shared `jiraKeys.ts` util

Extract the Jira-key regex + extractor (currently private to `gitlabService.ts:7,104-107`) into a shared module so GitHub and GitLab share one implementation (DRY).

**Files:**
- Create: `frontend/services/jiraKeys.ts`
- Create: `frontend/services/__tests__/jiraKeys.test.ts`
- Modify: `frontend/services/gitlabService.ts` (import from the new util; drop the local copies; keep the re-export at line 397 for back-compat)

**Interfaces:**
- Produces: `JIRA_KEY_RE: RegExp` (global, lookbehind-bounded) and `extractJiraKeys(text: string): string[]` (unique keys).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/services/__tests__/jiraKeys.test.ts
import { describe, expect, it } from 'vitest';
import { extractJiraKeys } from '../jiraKeys';

describe('extractJiraKeys', () => {
	it('extracts multiple unique keys', () => {
		expect(extractJiraKeys('PUMA-12 and ABC-3 and PUMA-12')).toEqual([
			'PUMA-12',
			'ABC-3',
		]);
	});

	it('respects the left boundary (no PROJ-5 from XPROJ-5)', () => {
		expect(extractJiraKeys('XPROJ-5')).toEqual([]);
	});

	it('allows single-letter project keys', () => {
		expect(extractJiraKeys('A-1 fix')).toEqual(['A-1']);
	});

	it('returns [] when there are no keys', () => {
		expect(extractJiraKeys('no keys here')).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/services/__tests__/jiraKeys.test.ts`
Expected: FAIL — cannot find module `../jiraKeys`.

- [ ] **Step 3: Create the util**

```ts
// frontend/services/jiraKeys.ts
// Match standard Jira issue keys (e.g. PROJ-12, A-1) while requiring a left
// boundary so we don't extract `PROJ-5` from a longer token like `XPROJ-5`.
// `[A-Z][A-Z0-9]*` allows single-letter project keys (`A-1`).
export const JIRA_KEY_RE = /(?<![A-Z0-9])([A-Z][A-Z0-9]*-\d+)/g;

export function extractJiraKeys(text: string): string[] {
	const matches = text.match(JIRA_KEY_RE);
	return matches ? [...new Set(matches)] : [];
}
```

- [ ] **Step 4: Point `gitlabService.ts` at the shared util**

In `frontend/services/gitlabService.ts`:
- Replace the top import block's first line region: add `import { extractJiraKeys, JIRA_KEY_RE } from './jiraKeys';` and DELETE the local `const JIRA_KEY_RE = …` (line 7) and the local `function extractJiraKeys` (lines 104-107).
- Keep the final `export { JIRA_KEY_RE, extractJiraKeys };` (line 397) so existing importers (and tests) still resolve them through `gitlabService`.

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run frontend/services/__tests__/jiraKeys.test.ts frontend/services/__tests__/gitlabService.test.ts`
Expected: PASS (both files).

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add frontend/services/jiraKeys.ts frontend/services/__tests__/jiraKeys.test.ts frontend/services/gitlabService.ts
git commit -m "refactor(services): extract shared jiraKeys util from gitlabService"
```

---

### Task 2: `'github'` source + GitHub config fields

Add `'github'` to the suggestion source union and `githubToken`/`githubHost` to config (host seeded but unused in UI).

**Files:**
- Modify: `types/Suggestion.ts:5-12` (source union)
- Modify: `frontend/stores/useConfigStore.ts` (Config interface `:42-43` area; `createDefaultConfig` `:179-180`; `normalizeConfig` `:255-259`; `CONFIG_STORAGE_VERSION` `:78`; migration comment `:308`)
- Test: `frontend/stores/__tests__/useConfigStore.test.ts`

**Interfaces:**
- Produces: `Config.githubToken: string`, `Config.githubHost: string`; `WorklogSuggestion.source` now includes `'github'`.

- [ ] **Step 1: Write the failing test**

```ts
// append to frontend/stores/__tests__/useConfigStore.test.ts
import { createDefaultConfig, normalizeConfig } from '../useConfigStore';

describe('github config fields', () => {
	it('defaults github fields to empty strings', () => {
		const c = createDefaultConfig();
		expect(c.githubToken).toBe('');
		expect(c.githubHost).toBe('');
	});

	it('trims githubToken and normalizes githubHost', () => {
		const c = normalizeConfig({
			githubToken: '  tok  ',
			githubHost: 'https://github.example.com/',
		});
		expect(c.githubToken).toBe('tok');
		expect(c.githubHost).toBe('github.example.com');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/stores/__tests__/useConfigStore.test.ts -t "github config fields"`
Expected: FAIL — `githubToken`/`githubHost` are `undefined`.

- [ ] **Step 3: Add the source union member**

In `types/Suggestion.ts`, add `| 'github'` to the `source` union (after `| 'gitlab'` on line 7):

```ts
	source:
		| 'jira-activity'
		| 'gitlab'
		| 'github'
		| 'calendar'
		| 'rescuetime'
		| 'favorite'
		| 'template'
		| 'previous-week';
```

- [ ] **Step 4: Add config fields**

In `frontend/stores/useConfigStore.ts`:

Config interface — after `gitlabHost: string;` (line 43) add:
```ts
	githubToken: string;
	githubHost: string;
```

`createDefaultConfig` — after `gitlabHost: '',` (line 180) add:
```ts
		githubToken: '',
		githubHost: '',
```

`normalizeConfig` return — after the `gitlabHost: normalizeHost(...)` line (259) add:
```ts
		githubToken:
			typeof config?.githubToken === 'string'
				? config.githubToken.trim()
				: fallback.githubToken.trim(),
		githubHost: normalizeHost(config?.githubHost ?? fallback.githubHost),
```

Bump version + comment: change `CONFIG_STORAGE_VERSION = 7` → `8` (line 78); rename `migrateLegacy_v0_to_v7` → `migrateLegacy_v0_to_v8` (definition line 317 + call line 331); add to the comment block (after the v7 line ~309):
```
 *   v8 → added githubToken/githubHost (strings, default ''). No shape change;
 *        `normalizeConfig` fills the fields for pre-v8 blobs.
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run frontend/stores/__tests__/useConfigStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add types/Suggestion.ts frontend/stores/useConfigStore.ts frontend/stores/__tests__/useConfigStore.test.ts
git commit -m "feat(config): add github source + githubToken/githubHost fields"
```

---

### Task 3: GitHub Events service (`githubService.ts`)

Fetch the user's GitHub events and turn keyed activity (incl. reviews/comments on others' PRs) into `WorklogSuggestion`s.

**Files:**
- Create: `frontend/services/githubService.ts`
- Test: `frontend/services/__tests__/githubService.test.ts`

**Interfaces:**
- Consumes: `extractJiraKeys` (Task 1); `ServiceError`, `fromRichMessage` from `./serviceErrors`; `WorklogSuggestion` from `../../types/Suggestion`.
- Produces:
  - `normalizeGithubHost(host: string): string`
  - `buildGithubApiBase(host: string, corsProxy: string): string`
  - `describeGithubConnectionError(error: unknown, host: string): string`
  - `fetchGithubUser(token: string, host: string, corsProxy: string, signal?: AbortSignal): Promise<{ login: string; name: string | null }>`
  - `fetchGithubSuggestions(token: string, host: string, corsProxy: string, weekStart: string, weekEnd: string, signal?: AbortSignal): Promise<WorklogSuggestion[]>`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/services/__tests__/githubService.test.ts
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
		expect(out[0].reason).toMatch(/review comment/i);
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
		expect(await fetchGithubSuggestions('', '', '', '2026-06-15', '2026-06-21')).toEqual(
			[],
		);
		expect(spy).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/services/__tests__/githubService.test.ts`
Expected: FAIL — cannot find module `../githubService`.

- [ ] **Step 3: Implement the service**

```ts
// frontend/services/githubService.ts
import type { WorklogSuggestion } from '../../types/Suggestion';
import { extractJiraKeys } from './jiraKeys';
import { fromRichMessage, ServiceError } from './serviceErrors';

const GITHUB_API_VERSION = '2022-11-28';

type ActivityType = 'push' | 'pr-action' | 'review';

interface ActivityEntry {
	type: ActivityType;
	count: number;
	reasons: string[];
}

// Mirror gitlabService time heuristics.
const TIME_ESTIMATES: Record<ActivityType, { perUnit: number; max: number }> = {
	push: { perUnit: 3600, max: 4 * 3600 },
	'pr-action': { perUnit: 1800, max: 2 * 3600 },
	review: { perUnit: 900, max: 2 * 3600 },
};

interface GithubEvent {
	type: string;
	created_at: string;
	payload?: {
		ref?: string;
		commits?: { message?: string }[];
		action?: string;
		pull_request?: { title?: string; head?: { ref?: string } };
		issue?: { title?: string; pull_request?: unknown };
		comment?: { body?: string };
		review?: { body?: string };
	};
}

export function normalizeGithubHost(host: string): string {
	return host.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * github.com → `https://api.github.com` (called directly; CORS is open).
 * GHES → `https://<host>/api/v3`, optionally behind the user CORS proxy
 * (GHES CORS is not guaranteed). The host field is seeded in config but not
 * surfaced in the UI yet, so today this always returns the github.com base.
 */
export function buildGithubApiBase(host: string, corsProxy: string): string {
	const cleanHost = normalizeGithubHost(host);
	if (!cleanHost) return 'https://api.github.com';
	const origin = `https://${cleanHost}/api/v3`;
	return corsProxy ? `${corsProxy.replace(/\/$/, '')}/${origin}` : origin;
}

export function describeGithubConnectionError(
	error: unknown,
	host: string,
): string {
	const label = normalizeGithubHost(host) || 'github.com';
	if (
		error instanceof TypeError ||
		(error instanceof Error && /fetch|network/i.test(error.message))
	) {
		return `Could not reach ${label}. Check your network or token.`;
	}
	return error instanceof Error ? error.message : 'GitHub connection failed';
}

function headers(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': GITHUB_API_VERSION,
	};
}

function describeStatus(status: number, host: string): string {
	const label = normalizeGithubHost(host) || 'github.com';
	if (status === 401)
		return `GitHub rejected the token (401). Check it's active with repo + read:user scope.`;
	if (status === 403)
		return `GitHub denied access or rate-limited (403) on ${label}. Check scopes/SSO or retry shortly.`;
	return `GitHub API error on ${label}: ${status}.`;
}

export async function fetchGithubUser(
	token: string,
	host: string,
	corsProxy: string,
	signal?: AbortSignal,
): Promise<{ login: string; name: string | null }> {
	const base = buildGithubApiBase(host, corsProxy);
	let res: Response;
	try {
		res = await fetch(`${base}/user`, { headers: headers(token), signal });
	} catch (error) {
		if (error instanceof ServiceError) throw error;
		if (error instanceof Error && error.name === 'AbortError') throw error;
		throw fromRichMessage(
			'GitHub',
			undefined,
			describeGithubConnectionError(error, host),
		);
	}
	if (!res.ok) {
		throw fromRichMessage('GitHub', res.status, describeStatus(res.status, host));
	}
	const body = (await res.json()) as { login: string; name?: string | null };
	return { login: body.login, name: body.name ?? null };
}

function dateOnly(iso: string): string {
	return iso.slice(0, 10);
}

function estimateSeconds(type: ActivityType, count: number): number {
	const { perUnit, max } = TIME_ESTIMATES[type];
	return Math.min(count * perUnit, max);
}

function estimateConfidence(
	type: ActivityType,
	count: number,
): 'high' | 'medium' | 'low' {
	if (type === 'push') return count >= 3 ? 'high' : 'medium';
	if (type === 'pr-action') return 'medium';
	return count >= 3 ? 'medium' : 'low';
}

function reasonLabel(type: ActivityType, count: number): string {
	if (type === 'push') return `${count} commit${count > 1 ? 's' : ''}`;
	if (type === 'pr-action') return `${count} PR action${count > 1 ? 's' : ''}`;
	return `${count} review comment${count > 1 ? 's' : ''}`;
}

const PR_ACTION_EVENTS = new Set(['PullRequestEvent']);
const REVIEW_EVENTS = new Set([
	'PullRequestReviewEvent',
	'PullRequestReviewCommentEvent',
	'IssueCommentEvent',
]);

/**
 * Fetch the user's recent GitHub events and extract Jira keys to build worklog
 * suggestions. Captures pushes, PR open/merge actions, and — crucially —
 * reviews/comments on ANY PR (incl. others'), which dev-status cannot attribute.
 */
export async function fetchGithubSuggestions(
	token: string,
	host: string,
	corsProxy: string,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<WorklogSuggestion[]> {
	if (!token) return [];

	const base = buildGithubApiBase(host, corsProxy);
	const { login } = await fetchGithubUser(token, host, corsProxy, signal);

	const PER_PAGE = 100;
	const MAX_PAGES = 5; // GitHub caps the events feed at ~300 events / 90 days.
	const events: GithubEvent[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		let res: Response;
		try {
			res = await fetch(
				`${base}/users/${encodeURIComponent(login)}/events?per_page=${PER_PAGE}&page=${page}`,
				{ headers: headers(token), signal },
			);
		} catch (error) {
			if (error instanceof ServiceError) throw error;
			if (error instanceof Error && error.name === 'AbortError') throw error;
			throw fromRichMessage(
				'GitHub',
				undefined,
				describeGithubConnectionError(error, host),
			);
		}
		if (!res.ok) {
			throw fromRichMessage('GitHub', res.status, describeStatus(res.status, host));
		}
		const batch = (await res.json()) as GithubEvent[];
		events.push(...batch);
		if (batch.length < PER_PAGE) break;
		// The feed is reverse-chronological; stop once the page's oldest event is
		// before the window.
		const oldest = batch[batch.length - 1]?.created_at;
		if (oldest && dateOnly(oldest) < weekStart) break;
	}

	const grouped = new Map<string, ActivityEntry>();
	const bump = (
		day: string,
		key: string,
		type: ActivityType,
		reason: string,
		by = 1,
	) => {
		const mapKey = `${day}::${key}::${type}`;
		let entry = grouped.get(mapKey);
		if (!entry) {
			entry = { type, count: 0, reasons: [] };
			grouped.set(mapKey, entry);
		}
		entry.count += by;
		if (reason) entry.reasons.push(reason.slice(0, 80));
	};

	for (const event of events) {
		const day = dateOnly(event.created_at);
		if (day < weekStart || day > weekEnd) continue;
		const p = event.payload ?? {};

		if (event.type === 'PushEvent') {
			const branchKeys = p.ref ? extractJiraKeys(p.ref) : [];
			const msgKeys = (p.commits ?? []).flatMap((c) =>
				extractJiraKeys(c.message ?? ''),
			);
			const keys = [...new Set([...branchKeys, ...msgKeys])];
			if (keys.length === 0) continue;
			const commits = (p.commits ?? []).length || 1;
			const base2 = Math.floor(commits / keys.length);
			let remainder = commits % keys.length;
			for (const key of keys) {
				bump(
					day,
					key,
					'push',
					p.commits?.[0]?.message ?? '',
					base2 + (remainder > 0 ? 1 : 0),
				);
				if (remainder > 0) remainder--;
			}
		} else if (PR_ACTION_EVENTS.has(event.type)) {
			const title = p.pull_request?.title ?? '';
			const ref = p.pull_request?.head?.ref ?? '';
			const keys = [...new Set([...extractJiraKeys(title), ...extractJiraKeys(ref)])];
			if (keys.length === 0) continue;
			for (const key of keys) {
				bump(day, key, 'pr-action', `${p.action ?? 'updated'} PR: ${title}`);
			}
		} else if (REVIEW_EVENTS.has(event.type)) {
			// IssueCommentEvent fires for issues too; only count PR conversations.
			if (event.type === 'IssueCommentEvent' && !p.issue?.pull_request) continue;
			const title = p.pull_request?.title ?? p.issue?.title ?? '';
			const body = p.comment?.body ?? p.review?.body ?? '';
			const keys = [
				...new Set([...extractJiraKeys(title), ...extractJiraKeys(body)]),
			];
			if (keys.length === 0) continue;
			for (const key of keys) {
				bump(day, key, 'review', body || title);
			}
		}
	}

	// Merge activity types per (day, issueKey).
	const merged = new Map<
		string,
		{ seconds: number; confidence: 'high' | 'medium' | 'low'; reasons: string[] }
	>();
	const rank = { high: 2, medium: 1, low: 0 };
	for (const [mapKey, entry] of grouped) {
		const [day, issueKey] = mapKey.split('::');
		const dayIssueKey = `${day}::${issueKey}`;
		const seconds = estimateSeconds(entry.type, entry.count);
		const confidence = estimateConfidence(entry.type, entry.count);
		const reason = `${reasonLabel(entry.type, entry.count)}${
			entry.reasons.length ? `: ${entry.reasons.slice(0, 2).join('; ')}` : ''
		}`;
		const existing = merged.get(dayIssueKey);
		if (existing) {
			existing.seconds += seconds;
			existing.reasons.push(reason);
			if (rank[confidence] > rank[existing.confidence]) {
				existing.confidence = confidence;
			}
		} else {
			merged.set(dayIssueKey, { seconds, confidence, reasons: [reason] });
		}
	}

	const suggestions: WorklogSuggestion[] = [];
	for (const [dayIssueKey, data] of merged) {
		const [day, issueKey] = dayIssueKey.split('::');
		const capped = Math.min(data.seconds, 6 * 3600);
		const hours = capped / 3600;
		suggestions.push({
			id: `github-${issueKey}-${day}`,
			source: 'github',
			issueKey,
			date: day,
			suggestedTimeSpent:
				hours >= 1
					? `${Math.floor(hours)}h${hours % 1 >= 0.5 ? ' 30m' : ''}`
					: '30m',
			suggestedSeconds: capped,
			confidence: data.confidence,
			reason: data.reasons.join(' + '),
			logged: false,
		});
	}
	return suggestions;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/services/__tests__/githubService.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add frontend/services/githubService.ts frontend/services/__tests__/githubService.test.ts
git commit -m "feat(github): events-based worklog suggestion service"
```

---

### Task 4: Jira dev-status service (`devActivityService.ts`)

For the week's Jira issues, read linked GitHub commits/PRs from Jira's dev-status API and attribute the current user's work.

**Files:**
- Create: `frontend/services/devActivityService.ts`
- Test: `frontend/services/__tests__/devActivityService.test.ts`
- Modify: `frontend/services/jiraActivityService.ts:15-19` (add `id` to `JiraIssueWithChangelog`) — or define a local issue type in the new service; this plan adds `id` to the shared type.

**Interfaces:**
- Consumes: `fetchSearchPage` from `./jiraSearch`; `Config` from `../stores/useConfigStore`; `WorklogSuggestion`.
- Produces:
  - `interface DevActivityUser { githubLogin?: string | null; displayName?: string | null }`
  - `fetchDevActivitySuggestions(config: Config, weekStart: string, weekEnd: string, user: DevActivityUser, signal?: AbortSignal): Promise<WorklogSuggestion[]>`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/services/__tests__/devActivityService.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as jiraSearch from '../jiraSearch';
import { fetchDevActivitySuggestions } from '../devActivityService';
import { createDefaultConfig } from '../../stores/useConfigStore';

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
				json: async () => ({ summary: { repository: { overall: { count: 2 } } } }),
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
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ summary: { repository: { overall: { count: 1 } } } }) } as Response)
			.mockRejectedValueOnce(new Error('boom')) // detail for PUMA-1 fails
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ summary: {} }) } as Response); // PUMA-2 summary empty

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/services/__tests__/devActivityService.test.ts`
Expected: FAIL — cannot find module `../devActivityService`.

- [ ] **Step 3: Add `id` to the shared issue type**

In `frontend/services/jiraActivityService.ts`, change the interface (lines 15-19) to include `id`:

```ts
interface JiraIssueWithChangelog {
	id: string;
	key: string;
	fields: { summary?: string };
	changelog?: JiraChangelog;
}
```

- [ ] **Step 4: Implement the service**

```ts
// frontend/services/devActivityService.ts
import type { WorklogSuggestion } from '../../types/Suggestion';
import type { Config } from '../stores/useConfigStore';
import { fetchSearchPage } from './jiraSearch';

export interface DevActivityUser {
	githubLogin?: string | null;
	displayName?: string | null;
}

interface IssueRef {
	id: string;
	key: string;
	fields?: { summary?: string };
}

interface DevCommit {
	displayId?: string;
	message?: string;
	authorTimestamp?: string;
	author?: { name?: string };
}

interface DevDetailResponse {
	detail?: { repositories?: { name?: string; commits?: DevCommit[] }[] }[];
}

interface DevSummaryResponse {
	summary?: Record<string, { overall?: { count?: number } }>;
}

const DEV_BASE = '/rest/dev-status/latest/issue';

function dateOnly(iso: string): string {
	return iso.slice(0, 10);
}

/** Case-insensitive match of a dev author name against the user's identities. */
function isCurrentUser(authorName: string | undefined, user: DevActivityUser): boolean {
	if (!authorName) return false;
	const candidates = [user.githubLogin, user.displayName]
		.filter((v): v is string => !!v)
		.map((v) => v.toLowerCase());
	if (candidates.length === 0) return false;
	return candidates.includes(authorName.toLowerCase());
}

/**
 * For each Jira issue the user touched this week, read GitHub commits linked via
 * Jira's dev-status API and attribute the user's own commits (in-window) as
 * worklog suggestions. dev-status is an unofficial Jira API and best-effort:
 * per-issue failures are swallowed, and an empty result is a valid outcome
 * (integration not connected). Goes through the existing Jira request path
 * (`fetchSearchPage` builds the base URL / headers / proxy via Jira config).
 */
export async function fetchDevActivitySuggestions(
	config: Config,
	weekStart: string,
	weekEnd: string,
	user: DevActivityUser,
	signal?: AbortSignal,
): Promise<WorklogSuggestion[]> {
	if (!config.jiraHost || !config.apiToken) return [];

	const jql = `(assignee = currentUser() OR worklogAuthor = currentUser()) AND updated >= "${weekStart}" AND updated <= "${weekEnd}"`;
	const { issues } = await fetchSearchPage<IssueRef>(
		config,
		{ jql, fields: 'summary', maxResults: 50 },
		signal,
	);

	// fetchSearchPage builds the proxied/authed Jira base; mirror its URL shape
	// for the dev-status calls. We reuse the same base by deriving it from a
	// lightweight helper exported there (see jiraSearch.buildBaseUrl) — but to
	// keep this service self-contained we call through a thin wrapper below.
	const { jiraRequest } = await import('./jiraRequest');

	const out: WorklogSuggestion[] = [];

	for (const issue of issues) {
		try {
			const summary = (await jiraRequest(
				config,
				`${DEV_BASE}/summary?issueId=${issue.id}`,
				signal,
			)) as DevSummaryResponse;
			const counts = Object.values(summary.summary ?? {}).map(
				(v) => v.overall?.count ?? 0,
			);
			if (!counts.some((c) => c > 0)) continue;

			const detail = (await jiraRequest(
				config,
				`${DEV_BASE}/detail?issueId=${issue.id}&applicationType=GitHub&dataType=repository`,
				signal,
			)) as DevDetailResponse;

			const commits = (detail.detail ?? []).flatMap((d) =>
				(d.repositories ?? []).flatMap((r) => r.commits ?? []),
			);

			const byDay = new Map<string, { count: number; reasons: string[] }>();
			for (const c of commits) {
				if (!isCurrentUser(c.author?.name, user)) continue;
				if (!c.authorTimestamp) continue;
				const day = dateOnly(c.authorTimestamp);
				if (day < weekStart || day > weekEnd) continue;
				const e = byDay.get(day) ?? { count: 0, reasons: [] };
				e.count += 1;
				if (c.message) e.reasons.push(c.message.slice(0, 80));
				byDay.set(day, e);
			}

			for (const [day, e] of byDay) {
				const capped = Math.min(e.count * 3600, 6 * 3600);
				const hours = capped / 3600;
				out.push({
					id: `github-${issue.key}-${day}`,
					source: 'github',
					issueKey: issue.key,
					date: day,
					suggestedTimeSpent:
						hours >= 1
							? `${Math.floor(hours)}h${hours % 1 >= 0.5 ? ' 30m' : ''}`
							: '30m',
					suggestedSeconds: capped,
					confidence: e.count >= 3 ? 'high' : 'medium',
					reason: `${e.count} linked commit${e.count > 1 ? 's' : ''}${
						e.reasons.length ? `: ${e.reasons.slice(0, 2).join('; ')}` : ''
					}`,
					logged: false,
				});
			}
		} catch {
			// Best-effort: skip this issue, keep going.
		}
	}

	return out;
}
```

- [ ] **Step 5: Add the thin `jiraRequest` helper the service imports**

The service needs an arbitrary authed-and-proxied Jira GET. `jiraSearch.ts` already builds this internally (`buildBaseUrl` at `:55-59`, applies hosted-proxy rewrite). Add a small exported helper there rather than duplicate URL/header logic.

Create `frontend/services/jiraRequest.ts`:

```ts
// frontend/services/jiraRequest.ts
import type { Config } from '../stores/useConfigStore';
import { buildJiraRequest } from './jiraSearch';

/**
 * Issue an authenticated, proxy-aware GET against an arbitrary Jira REST path
 * (e.g. /rest/dev-status/...). Reuses jiraSearch's URL+header+hosted-proxy
 * construction so dev-status calls travel the exact same path as searches.
 */
export async function jiraRequest(
	config: Config,
	path: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const { url, headers } = buildJiraRequest(config, path);
	const res = await fetch(url, { headers, signal });
	if (!res.ok) throw new Error(`Jira request failed: ${res.status}`);
	return res.json();
}
```

Then in `frontend/services/jiraSearch.ts`, export a `buildJiraRequest(config, path)` that returns `{ url, headers }` using the SAME logic `fetchSearchPage` uses today (base URL via the existing `buildBaseUrl`, auth header, and `rewriteForHostedProxy` from `jiraGateway`). Locate how `fetchSearchPage` (`:93`) assembles `url`/`headers` and factor that into `buildJiraRequest` so both call it. (Inspect `:55-149` and reuse verbatim — do not re-derive.)

> Implementer note: `jiraSearch.ts` already imports/uses `rewriteForHostedProxy`. `buildJiraRequest` must apply the same rewrite so dev-status works for hosted-proxy (Premium) users, not just direct/self-hosted.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run frontend/services/__tests__/devActivityService.test.ts`
Expected: PASS. (The test mocks `globalThis.fetch`, so `jiraRequest`'s fetch is intercepted; if `buildJiraRequest` requires fields not in the test config, default them.)

- [ ] **Step 7: Run the Jira search tests to confirm no regression + typecheck**

Run: `npx vitest run frontend/services/__tests__/jiraSearch.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/services/devActivityService.ts frontend/services/jiraRequest.ts frontend/services/jiraSearch.ts frontend/services/jiraActivityService.ts frontend/services/__tests__/devActivityService.test.ts
git commit -m "feat(devactivity): jira dev-status worklog suggestions"
```

---

### Task 5: `testGithub` action + coverage preview (settings store)

**Files:**
- Modify: `frontend/stores/useSettingsFormStore.ts` — add `github` to `SettingsIntegrationTests` (`:23-28`), the action type (`:46` region), and a `testGithub` action mirroring `testGitlab` (`:506-585`).
- Test: `frontend/stores/__tests__/useSettingsFormStore.test.ts`

**Interfaces:**
- Consumes: `fetchGithubUser`, `fetchGithubSuggestions` (Task 3); `extractJiraKeys` indirectly.
- Produces: `useSettingsFormStore().testGithub(): Promise<void>`; `integrationTests.github: IntegrationTestResult`.

- [ ] **Step 1: Write the failing test**

```ts
// append to frontend/stores/__tests__/useSettingsFormStore.test.ts (new describe)
describe('testGithub', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('reports connected + coverage on success', async () => {
		act(() => {
			useSettingsFormStore.setState({
				formData: { ...baseConfig, githubToken: 'tok' },
				integrationTests: {
					jira: { loading: false, result: null },
					gitlab: { loading: false, result: null },
					github: { loading: false, result: null },
					calendar: { loading: false, result: null },
					rescuetime: { loading: false, result: null },
				},
			});
		});

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ login: 'me', name: 'Me' }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							type: 'PushEvent',
							created_at: new Date().toISOString(),
							payload: { ref: 'refs/heads/PUMA-1', commits: [{ message: 'x' }] },
						},
					]),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(new Response('[]', { status: 200 }));

		await act(async () => {
			await useSettingsFormStore.getState().testGithub();
		});

		const result =
			useSettingsFormStore.getState().integrationTests.github.result;
		expect(result?.success).toBe(true);
		expect(result?.message).toContain('@me');
		expect(result?.message).not.toContain('tok'); // never echo the token
	});

	it('maps 401 to a token-rejected message', async () => {
		act(() => {
			useSettingsFormStore.setState({
				formData: { ...baseConfig, githubToken: 'bad' },
				integrationTests: {
					jira: { loading: false, result: null },
					gitlab: { loading: false, result: null },
					github: { loading: false, result: null },
					calendar: { loading: false, result: null },
					rescuetime: { loading: false, result: null },
				},
			});
		});
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('{}', { status: 401 }),
		);

		await act(async () => {
			await useSettingsFormStore.getState().testGithub();
		});

		const result =
			useSettingsFormStore.getState().integrationTests.github.result;
		expect(result?.success).toBe(false);
		expect(result?.message).toMatch(/401|token/i);
	});
});
```

Note: extend the `beforeEach` `integrationTests` object (test file `:48-59`) to include `github: { loading: false, result: null }` so existing setup stays valid.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/stores/__tests__/useSettingsFormStore.test.ts -t "testGithub"`
Expected: FAIL — `testGithub` is not a function / type error on `github` channel.

- [ ] **Step 3: Implement**

In `frontend/stores/useSettingsFormStore.ts`:

Add to `SettingsIntegrationTests` (after `gitlab` at `:25`): `github: IntegrationTestResult;`

Add to the actions interface (near `:46`): `testGithub: () => Promise<void>;`

Add the import near the other service imports:
```ts
import {
	fetchGithubSuggestions,
	fetchGithubUser,
} from '../services/githubService';
```

Add the action (mirror `testGitlab`):
```ts
	testGithub: async () => {
		set((s) => ({
			integrationTests: {
				...s.integrationTests,
				github: { loading: true, result: null },
			},
		}));
		try {
			const { formData } = get();
			const normalizedConfig = normalizeConfig(formData);
			if (!normalizedConfig.githubToken) {
				throw new Error('GitHub token is required');
			}
			const token = normalizedConfig.githubToken;
			const host = normalizedConfig.githubHost;

			// Validate token + identity (throws ServiceError with friendly copy).
			const user = await fetchGithubUser(token, host, '');

			// Coverage preview: how many of this week's events carry Jira keys.
			const today = toLocalDateString(new Date());
			const weekAgo = toLocalDateString(
				new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
			);
			const suggestions = await fetchGithubSuggestions(
				token,
				host,
				'',
				weekAgo,
				today,
			);
			const keyed = suggestions.length;
			const sample = suggestions
				.slice(0, 3)
				.map((s) => s.issueKey)
				.join(', ');

			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					github: {
						loading: false,
						result: {
							success: true,
							message:
								keyed > 0
									? `Connected as @${user.login} — ${keyed} issue${keyed > 1 ? 's' : ''} with Jira-keyed activity this week (e.g. ${sample}).`
									: `Connected as @${user.login} — no Jira-keyed GitHub activity found this week. dev-panel links may still produce suggestions.`,
						},
					},
				},
			}));
		} catch (error) {
			set((s) => ({
				integrationTests: {
					...s.integrationTests,
					github: {
						loading: false,
						result: {
							success: false,
							message:
								error instanceof Error ? error.message : 'GitHub connection failed',
						},
					},
				},
			}));
		}
	},
```

Also update any place that constructs a full `integrationTests` literal (search the file for `rescuetime: {` siblings) to include `github: { loading: false, result: null }` — at minimum the initial state default.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run frontend/stores/__tests__/useSettingsFormStore.test.ts`
Expected: PASS (all, including existing testJira/testGitlab/testRescueTime).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add frontend/stores/useSettingsFormStore.ts frontend/stores/__tests__/useSettingsFormStore.test.ts
git commit -m "feat(settings): testGithub action with coverage preview"
```

---

### Task 6: Settings UI — GitHub card

**Files:**
- Modify: `frontend/react/components/settings/sections/IntegrationsSection.tsx` (new GitHub card + props)
- Modify: `frontend/react/components/settings/SettingsForm.tsx` (IDs, status, `canTestGithub`, wiring `:518-545`)

**Interfaces:**
- Consumes: `integrationTests.github`, `testGithub` (Task 5); `formData.githubToken`.

- [ ] **Step 1: Extend `IntegrationsSection` props**

In `IntegrationsSection.tsx` `Props` (`:28-86`) add: `githubToken: string;` `githubTokenId: string;` `githubStatus: ServiceStatus;` `testGithub: () => void;` `canTestGithub: boolean;` and in `integrationTests` (`:45-49`) add `github: IntegrationTestResult;`. Add them to the destructure (`:93-129`).

- [ ] **Step 2: Add the GitHub card markup**

Insert a new `<section className={styles.serviceCard}>` immediately after the GitLab card (`:146-216`), mirroring its structure. Use this body:

```tsx
<section className={styles.serviceCard}>
	<div className={styles.serviceHeader}>
		<div className={styles.serviceHeading}>
			<p className={styles.serviceKicker}>GitHub</p>
			<h3>Development activity</h3>
			<p>
				Suggest worklogs from your GitHub commits, PRs, and reviews —
				including review comments on others' PRs.
			</p>
		</div>
		<span
			className={`${styles.serviceStatusBadge} ${githubStatus.tone === 'ready' ? styles.serviceStatusReady : githubStatus.tone === 'warning' ? styles.serviceStatusWarning : styles.serviceStatusPending}`}
		>
			{githubStatus.label}
		</span>
	</div>
	<div className={styles.formGroup}>
		<label htmlFor={githubTokenId}>GitHub token</label>
		<input
			type="password"
			id={githubTokenId}
			name="githubToken"
			value={githubToken}
			onChange={handleChange}
		/>
		<small>
			Classic PAT with <code>repo</code> + <code>read:user</code> scope, or a
			fine-grained PAT with read access to your repos.
		</small>
	</div>
	<div className={styles.serviceActions}>
		<Button
			type="button"
			variant="secondary"
			onClick={testGithub}
			disabled={integrationTests.github.loading || !canTestGithub}
		>
			{integrationTests.github.loading ? 'Testing...' : 'Test GitHub'}
		</Button>
	</div>
	{integrationTests.github.result ? (
		<p
			className={`${styles.testResult} ${integrationTests.github.result.success ? styles.testSuccess : styles.testError}`}
		>
			{integrationTests.github.result.message}
		</p>
	) : (
		<p className={styles.serviceHint}>
			Works directly with github.com — no CORS proxy needed.
		</p>
	)}
</section>
```

- [ ] **Step 3: Wire it in `SettingsForm.tsx`**

- Add `const githubTokenId = useId();` near the other IDs (`:171-173`).
- Add `const testGithub = useSettingsFormStore((state) => state.testGithub);` near `:138`.
- Add `const canTestGithub = !!formData.githubToken.trim();` near `:184`.
- Add `const githubStatus = getServiceStatus(!!formData.githubToken.trim(), integrationTests.github.loading, integrationTests.github.result);` near `:209`.
- In the `<IntegrationsSection ... />` props (`:518-545`) add: `githubToken={formData.githubToken}` `githubTokenId={githubTokenId}` `githubStatus={githubStatus}` `testGithub={testGithub}` `canTestGithub={canTestGithub}`. (`integrationTests` is already passed whole.)

- [ ] **Step 4: Typecheck + lint + run the settings store tests**

Run:
```bash
npx tsc --noEmit
npx biome check --write frontend/react/components/settings/sections/IntegrationsSection.tsx frontend/react/components/settings/SettingsForm.tsx
npx vitest run frontend/stores/__tests__/useSettingsFormStore.test.ts
```
Expected: no type errors; PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/react/components/settings/sections/IntegrationsSection.tsx frontend/react/components/settings/SettingsForm.tsx
git commit -m "feat(settings): GitHub integration card + test button"
```

---

### Task 7: Dashboard wiring + merge

Fetch both GitHub sources on the dashboard and feed them to `mergeSuggestions` with the existing dedup.

**Files:**
- Modify: `frontend/stores/useDashboardStore.ts` (add `github` to loading/error channels: `:84-87`, `:111-117`, `:122-134`, `:151-154`, and an `isLoadingGithubSuggestions` flag + `githubSuggestionsError`)
- Modify: `frontend/services/suggestionMerger.ts` (`MergeSuggestionsInput` `:30-33`, destructure `:241-253`, `allSuggestions` `:298-302`)
- Modify: `frontend/react/hooks/useDashboardDataFetcher.ts` (fetch both sources; destructure `:242-246`; merge `:396-405`)
- Test: `frontend/services/__tests__/suggestionMerger.test.ts`

**Interfaces:**
- Consumes: `fetchGithubSuggestions` (Task 3), `fetchDevActivitySuggestions` (Task 4), `fetchGithubUser` (Task 3).

- [ ] **Step 1: Write the failing merger test**

```ts
// append to frontend/services/__tests__/suggestionMerger.test.ts
import { mergeSuggestions } from '../suggestionMerger';

describe('github suggestions merge', () => {
	it('includes github suggestions and dedups against gitlab by confidence', () => {
		const base = {
			weekStart: '2026-06-15',
			jiraSuggestions: [],
			gitlabSuggestions: [
				{
					id: 'gitlab-PUMA-1-2026-06-16',
					source: 'gitlab' as const,
					issueKey: 'PUMA-1',
					date: '2026-06-16',
					suggestedTimeSpent: '30m',
					suggestedSeconds: 1800,
					confidence: 'low' as const,
					reason: 'gl',
					logged: false,
				},
			],
			githubSuggestions: [
				{
					id: 'github-PUMA-1-2026-06-16',
					source: 'github' as const,
					issueKey: 'PUMA-1',
					date: '2026-06-16',
					suggestedTimeSpent: '1h',
					suggestedSeconds: 3600,
					confidence: 'high' as const,
					reason: 'gh',
					logged: false,
				},
			],
			calendarSuggestions: [],
			rescueTimeData: new Map(),
			existingWorklogs: [],
			timeRounding: 'off' as const,
		};
		const days = mergeSuggestions(base as never);
		const all = days.flatMap((d) => d.suggestions);
		const puma1 = all.filter((s) => s.issueKey === 'PUMA-1');
		// Deduped to one, the higher-confidence GitHub one wins.
		expect(puma1).toHaveLength(1);
		expect(puma1[0].source).toBe('github');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/services/__tests__/suggestionMerger.test.ts -t "github suggestions merge"`
Expected: FAIL — `githubSuggestions` not accepted / not merged.

- [ ] **Step 3: Extend the merger**

In `frontend/services/suggestionMerger.ts`:
- `MergeSuggestionsInput` (after `gitlabSuggestions:` `:33`): `githubSuggestions: WorklogSuggestion[];`
- Destructure (after `gitlabSuggestions,` `:244`): `githubSuggestions,`
- `allSuggestions` (after `...gitlabSuggestions,` `:300`): `...githubSuggestions,`

- [ ] **Step 4: Run merger test to verify pass**

Run: `npx vitest run frontend/services/__tests__/suggestionMerger.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `github` dashboard channel**

In `frontend/stores/useDashboardStore.ts`:
- State: add `githubSuggestionsError: string | null;` (after `gitlabSuggestionsError` `:86`) and an `isLoadingGithubSuggestions: boolean;` (find the `isLoadingGitlabSuggestions` flag in the loading group and add the sibling).
- `setLoading`/`setError` source unions (`:112`, `:116`): add `| 'github'`.
- Loading map (`:122-126`): `github: 'isLoadingGithubSuggestions',`
- Error map (`:130-134`): `github: 'githubSuggestionsError',`
- Initial state (`:151-154` + the loading defaults): `githubSuggestionsError: null,` and `isLoadingGithubSuggestions: false,` (match how `isLoadingGitlabSuggestions` is defaulted).

- [ ] **Step 6: Wire the fetcher**

In `frontend/react/hooks/useDashboardDataFetcher.ts`:

Add config reads near `:135-137`:
```ts
	const githubToken = useConfigStore((s) => s.config.githubToken);
	const githubHost = useConfigStore((s) => s.config.githubHost);
```
Add them to the `config` object (`:179-191`) and to the effect dep array (mirror `gitlabToken`/`gitlabHost`).

Add imports at the top:
```ts
import { fetchGithubSuggestions, fetchGithubUser } from '../../services/githubService';
import { fetchDevActivitySuggestions } from '../../services/devActivityService';
```

Inside `run()`, before the `Promise.all`, resolve the GitHub identity once (best-effort) so dev-status author matching is precise:
```ts
		let githubUser: { githubLogin?: string | null; displayName?: string | null } = {};
		if (githubToken) {
			try {
				const u = await fetchGithubUser(githubToken, githubHost, '', signal);
				githubUser = { githubLogin: u.login, displayName: u.name };
			} catch {
				// identity is best-effort; dev-status falls back to no GitHub login
			}
		}
```

Add two entries to the `Promise.all` array (after the gitlab entry `:336-350`):
```ts
				githubToken
					? fetchGithubSuggestions(
							githubToken,
							githubHost,
							'',
							weekStart,
							weekEnd,
							signal,
						)
							.catch((e) => {
								if (!signal.aborted) setError('github', e.message);
								return [];
							})
							.finally(() => setLoading('github', false))
					: Promise.resolve([]),

				fetchDevActivitySuggestions(config, weekStart, weekEnd, githubUser, signal)
					.catch((e) => {
						if (!signal.aborted) setError('github', e.message);
						return [];
					}),
```

Update the destructuring (`:242-246`) to capture both, e.g.:
```ts
			jiraSuggestions,
			gitlabSuggestions,
			calendarSuggestions,
			rescueTimeData,
			githubEvents,
			devActivity,
		] = await Promise.all([
```
(Insert the two new promises in the SAME order in the array. Keep existing entries' positions; append the two GitHub promises at the end of the array and add `githubEvents`/`devActivity` as the last two destructured names.)

Combine and pass to `mergeSuggestions` (`:396-405`):
```ts
			const githubSuggestions = [...githubEvents, ...devActivity];
```
then add `githubSuggestions,` to the `mergeSuggestions({ ... })` argument object.

> Implementer note: `setLoading('github', false)` is only attached to the events promise's `.finally`. That's fine — the loading flag tracks the GitHub-token fetch; dev-status is silent enrichment. If `githubToken` is empty, call `setLoading('github', false)` once up-front (mirror how empty gitlab resolves) so the flag never sticks.

- [ ] **Step 7: Typecheck, lint, full suite**

Run:
```bash
npx tsc --noEmit
npx biome check --write frontend/stores/useDashboardStore.ts frontend/services/suggestionMerger.ts frontend/react/hooks/useDashboardDataFetcher.ts
npx vitest run
```
Expected: no type errors; **all tests pass**.

- [ ] **Step 8: Commit**

```bash
git add frontend/stores/useDashboardStore.ts frontend/services/suggestionMerger.ts frontend/react/hooks/useDashboardDataFetcher.ts frontend/services/__tests__/suggestionMerger.test.ts
git commit -m "feat(dashboard): wire GitHub events + dev-status suggestions into merge"
```

---

### Task 8: Final verification + PR

- [ ] **Step 1: Full gate**

Run:
```bash
npx tsc --noEmit
npx biome check .
npx vitest run
npm run -s check:premium-boundary
```
Expected: all clean / all pass. (No `frontend/ → premium/` imports were added, so the boundary check stays green.)

- [ ] **Step 2: Manual smoke (optional but recommended)**

Start the app (`npm run dev`), open Settings → Integrations, paste a GitHub token, click **Test GitHub**, confirm the coverage message. Then open the dashboard for a week with known GitHub activity and confirm GitHub-sourced suggestions appear and merge with Jira/GitLab without duplicate per-(day,issue) entries.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/github-dev-activity-worklogs
gh pr create --base main --title "feat: GitHub-driven worklog suggestions (dev-status + Events hybrid)" --body "<summary from the spec; link docs/superpowers/specs/2026-06-23-github-dev-activity-worklogs-design.md>"
```
Wait for `quality` + `e2e-smoke` to pass before merge. (Merge may require the user's account — the agent's `gh` token cannot merge.)

---

## Self-Review

**Spec coverage:**
- Source 1 (dev-status) → Task 4. Source 2 (Events incl. review/comment on others' PRs) → Task 3. ✓
- github.com direct / no proxy → Task 3 `buildGithubApiBase`. ✓
- Config `githubToken`/`githubHost` (host seeded, UI hidden) → Task 2 + Task 6 (only token field shown). ✓
- `'github'` source + merge dedup-by-confidence, no summing → Task 2 + Task 7. ✓
- Shared `jiraKeys.ts` → Task 1. ✓
- Test button + coverage preview → Task 5. ✓
- Author matching (GitHub login + Jira display name) → Task 4 `isCurrentUser` + Task 7 identity resolution. ✓
- Error handling: GitHub 401/403/network; dev-status per-issue isolation + empty-is-ok → Task 3 / Task 4. ✓
- Tests for each → Tasks 1-7. ✓
- GHES/Bitbucket out of scope → not built (host field unsurfaced). ✓

**Placeholder scan:** One soft spot — Task 4 Step 5 asks the implementer to factor `buildJiraRequest` out of existing `fetchSearchPage` internals rather than giving the verbatim body, because that body wasn't read in full during planning. The implementer must read `jiraSearch.ts:55-149` and reuse the existing base-URL/header/`rewriteForHostedProxy` logic. This is a deliberate "reuse existing pattern" instruction, not an unspecified new behavior. All NEW code is shown in full.

**Type consistency:** `fetchGithubSuggestions(token, host, corsProxy, weekStart, weekEnd, signal?)` used identically in Tasks 3/5/7. `fetchDevActivitySuggestions(config, weekStart, weekEnd, user, signal?)` and `DevActivityUser { githubLogin?, displayName? }` consistent across Tasks 4/7. Suggestion id scheme `github-<key>-<date>` identical in Tasks 3 and 4 (so an events+devstatus duplicate for the same issue/day collapses by id AND by the merger's `(date,issueKey)` dedup). Source string `'github'` consistent. `github` dashboard channel naming (`isLoadingGithubSuggestions`, `githubSuggestionsError`) consistent in Task 7.
