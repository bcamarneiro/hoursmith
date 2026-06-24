# Tempo Worklog Integration — Plan 1: Foundation + Current-User Reads + Detection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Tempo-managed Jira instance show the current user's worklogs by reading them from the Tempo Cloud API, behind auto-detection and a source resolver, without touching the working Jira write paths.

**Architecture:** A new gateway (`tempoGateway`) routes `api.tempo.io` requests through the Premium hosted relay / self-hosted proxy / direct (mirroring `rescueTimeGateway`). A pure mapper (`tempoMapper`) turns Tempo worklogs into the app's `EnrichedJiraWorklog` shape, enriching Tempo's id-only issues from Jira. A read service (`tempoWorklogService`) composes accountId resolution + Tempo fetch + enrichment. A thin resolver (`worklogSource`) decides Jira vs Tempo; existing read hooks consult it. Jira paths are the untouched default.

**Tech Stack:** TypeScript, React, Zustand, TanStack Query, Vitest, Biome. No new runtime dependencies.

## Global Constraints

- Tempo deployment is **Cloud only** — base URL `https://api.tempo.io/4/`, auth `Authorization: Bearer <Tempo API token>`.
- **No new npm dependencies.** Reuse existing helpers: `searchAllIssues`/`fetchSearchPage` (`frontend/services/jiraSearch.ts`), `ServiceError`/`fromHttpResponse`/`fromNetworkError` (`frontend/services/serviceErrors.ts`), `getProxyOverrideState` (`frontend/services/proxyUrlBridge.ts`), `parseTimeSpentToSeconds`/`formatJiraTimeSpent` (`frontend/react/utils/timeSpent.ts`, `format.ts`).
- **Return the existing shapes** — `WorklogEntry` (week) and `EnrichedJiraWorklog[]` (month) so downstream hooks/components are unchanged.
- **Never silently drop a worklog** (cf. ADA-456a): a missing issue renders with a placeholder; a failed Tempo fetch fails the whole read.
- **Day comes from Tempo `startDate`** (no instant reconstruction). `started` is synthesized as `${startDate}T${startTime ?? '00:00:00'}` only so `worklogMonth()`/`new Date()` consumers keep working. Backdate flagging is **off** for Tempo v1.
- Test files live in a sibling `__tests__/` dir, named `<module>.test.ts`. Use `vi.stubGlobal('fetch', …)` per the existing service tests.
- Run the full suite with `npx vitest run`; a single file with `npx vitest run <path>`.
- Premium-only code must keep `node scripts/check-premium-boundary.cjs` passing.
- Spec: `docs/superpowers/specs/2026-06-24-tempo-worklog-integration-design.md`.

---

## File Structure

- Create `frontend/services/jiraIdentity.ts` — resolve + cache the current user's Jira `accountId` via `/myself`.
- Create `frontend/services/tempoGateway.ts` — 3-mode URL/header builder for `api.tempo.io`.
- Create `frontend/services/worklogSource.ts` — `getWorklogSource()` resolver + `looksLikeTempoManaged()` detection predicate.
- Create `frontend/services/tempoMapper.ts` — pure `mapTempoWorklog()` + `fetchIssueMetadata()` (chunked Jira enrichment).
- Create `frontend/services/tempoWorklogService.ts` — `fetchWeekWorklogsTempo()` + `fetchMonthWorklogsTempo()`.
- Create `premium/api/_lib/tempoForward.ts` — server-side forward to `api.tempo.io` (read methods in Plan 1).
- Create `api/tempo/index.ts` + `premium/api/tempo/index.ts` — the hosted relay endpoint.
- Modify `frontend/stores/useConfigStore.ts` — add `tempoApiToken` + `tempoMode`, defaults, normalize, version bump.
- Modify `frontend/stores/useUIStore.ts` — add `tempoSuspected` transient flag + setter.
- Modify `frontend/services/worklogService.ts` + `monthWorklogService.ts` — set `tempoSuspected` when app-account authors are seen.
- Modify `frontend/react/hooks/useMonthWorklogs.ts` (+ `useTimesheetDataFetcher.ts` as the week caller) — route through `getWorklogSource()`.
- Modify the Settings UI (the RescueTime settings section's host component) — Tempo token field, `tempoMode` control, Test-connection button, detection banner.

Tasks are ordered so each builds only on earlier ones.

---

## Task 1: Config fields `tempoApiToken` + `tempoMode`

**Files:**
- Modify: `frontend/stores/useConfigStore.ts` (Config interface ~line 32-72; `createDefaultConfig` ~line 170-195; `normalizeConfig` ~line 197-300; `CONFIG_STORAGE_VERSION`)
- Test: `frontend/stores/__tests__/useConfigStore.test.ts`

**Interfaces:**
- Produces: `Config.tempoApiToken: string`, `Config.tempoMode: 'auto' | 'jira' | 'tempo'` (default `'auto'`).

- [ ] **Step 1: Write the failing test**

Add to `frontend/stores/__tests__/useConfigStore.test.ts`:

```ts
it('defaults tempoApiToken to empty and tempoMode to auto', () => {
	const cfg = createDefaultConfig();
	expect(cfg.tempoApiToken).toBe('');
	expect(cfg.tempoMode).toBe('auto');
});

it('normalizes a missing tempoMode to auto and trims the token', () => {
	const cfg = normalizeConfig({ tempoApiToken: '  abc  ' } as Partial<Config>);
	expect(cfg.tempoApiToken).toBe('abc');
	expect(cfg.tempoMode).toBe('auto');
});

it('keeps a valid tempoMode and rejects an invalid one', () => {
	expect(normalizeConfig({ tempoMode: 'tempo' } as Partial<Config>).tempoMode).toBe('tempo');
	expect(normalizeConfig({ tempoMode: 'nonsense' } as unknown as Partial<Config>).tempoMode).toBe('auto');
});
```

(Ensure `createDefaultConfig`, `normalizeConfig`, and the `Config` type are imported in the test — extend the existing import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/stores/__tests__/useConfigStore.test.ts`
Expected: FAIL — `tempoApiToken`/`tempoMode` undefined.

- [ ] **Step 3: Implement**

In the `Config` interface, after `rescueTimeApiKey: string;` add:

```ts
	/** Tempo Cloud API token. Empty unless the user connects Tempo. */
	tempoApiToken: string;
	/**
	 * Worklog source selection.
	 * - `auto`  : Tempo when a token is present AND Tempo is detected; else Jira.
	 * - `jira`  : force native Jira worklogs.
	 * - `tempo` : force Tempo (covers the empty-worklog case detection can't see).
	 */
	tempoMode: 'auto' | 'jira' | 'tempo';
```

In `createDefaultConfig()`, after `rescueTimeApiKey: '',` add:

```ts
		tempoApiToken: '',
		tempoMode: 'auto',
```

In `normalizeConfig()`, after the `rescueTimeApiKey` block add:

```ts
		tempoApiToken:
			typeof config?.tempoApiToken === 'string'
				? config.tempoApiToken.trim()
				: fallback.tempoApiToken.trim(),
		tempoMode:
			config?.tempoMode === 'jira' ||
			config?.tempoMode === 'tempo' ||
			config?.tempoMode === 'auto'
				? config.tempoMode
				: fallback.tempoMode,
```

Bump `CONFIG_STORAGE_VERSION` by 1 (the legacy migrate path collapses to `normalizeConfig`, so the new fields are backfilled automatically).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/stores/__tests__/useConfigStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/stores/useConfigStore.ts frontend/stores/__tests__/useConfigStore.test.ts
git commit -m "feat(config): add tempoApiToken + tempoMode"
```

---

## Task 2: `jiraIdentity` — resolve current-user accountId

**Files:**
- Create: `frontend/services/jiraIdentity.ts`
- Test: `frontend/services/__tests__/jiraIdentity.test.ts`

**Interfaces:**
- Consumes: `buildJiraRequest` (`frontend/services/jiraSearch.ts`) for the hosted-proxy rewrite; `ServiceError` helpers.
- Produces: `resolveAccountId(config: { jiraHost: string; email: string; apiToken: string; corsProxy: string }, signal?: AbortSignal): Promise<string>`. Caches per `email@jiraHost` for the session.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetIdentityCache, resolveAccountId } from '../jiraIdentity';

const cfg = { jiraHost: 'x.atlassian.net', email: 'me@x.com', apiToken: 't', corsProxy: '' };

afterEach(() => {
	vi.restoreAllMocks();
	__resetIdentityCache();
});

describe('resolveAccountId', () => {
	it('returns the accountId from /myself', async () => {
		vi.stubGlobal('fetch', vi.fn(async () =>
			new Response(JSON.stringify({ accountId: 'acc-1' }), { status: 200 })));
		expect(await resolveAccountId(cfg)).toBe('acc-1');
	});

	it('caches so a second call makes no request', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ accountId: 'acc-1' }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		await resolveAccountId(cfg);
		await resolveAccountId(cfg);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('throws a ServiceError on a 401', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })));
		await expect(resolveAccountId(cfg)).rejects.toMatchObject({ kind: 'unauthorized' });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/services/__tests__/jiraIdentity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontend/services/jiraIdentity.ts`**

```ts
import { buildJiraRequest } from './jiraSearch';
import { fromHttpResponse, fromNetworkError } from './serviceErrors';

export interface IdentityConfig {
	jiraHost: string;
	email: string;
	apiToken: string;
	corsProxy: string;
}

const cache = new Map<string, string>();

/** Test-only: clear the session accountId cache. */
export function __resetIdentityCache(): void {
	cache.clear();
}

/**
 * The current user's Jira `accountId`. Tempo filters worklogs by accountId, not
 * email, so this is the email→accountId bridge. Cached per `email@host` for the
 * session (accountId is stable).
 */
export async function resolveAccountId(
	config: IdentityConfig,
	signal?: AbortSignal,
): Promise<string> {
	const key = `${config.email.toLowerCase()}@${config.jiraHost}`;
	const hit = cache.get(key);
	if (hit) return hit;

	const { url, headers } = buildJiraRequest(
		config,
		'/rest/api/2/myself',
	);
	let res: Response;
	try {
		res = await fetch(url, { headers, signal });
	} catch (err) {
		throw fromNetworkError('Jira myself', err);
	}
	if (!res.ok) throw fromHttpResponse('Jira myself', res.status);
	const body = (await res.json()) as { accountId?: string };
	if (!body.accountId) {
		throw fromHttpResponse('Jira myself', 500, 'no accountId in response');
	}
	cache.set(key, body.accountId);
	return body.accountId;
}
```

> If `buildJiraRequest`'s signature differs (confirm in `jiraSearch.ts:74`), adapt the call to produce `{ url, headers }` for `${base}/rest/api/2/myself`, applying the same hosted-proxy rewrite the other Jira reads use.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/services/__tests__/jiraIdentity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/services/jiraIdentity.ts frontend/services/__tests__/jiraIdentity.test.ts
git commit -m "feat(jira): resolve + cache current-user accountId via /myself"
```

---

## Task 3: `tempoGateway` — 3-mode request builder

**Files:**
- Create: `frontend/services/tempoGateway.ts`
- Test: `frontend/services/__tests__/tempoGateway.test.ts`

**Interfaces:**
- Consumes: `getProxyOverrideState()` (`proxyUrlBridge.ts`) → `{ hostedProxyUrl, userOverride, supabaseAccessToken }`.
- Produces:
  - `type TempoGatewayMode = 'hosted' | 'self-hosted' | 'direct'`
  - `getTempoGatewayMode(userConfiguredProxy: string): TempoGatewayMode`
  - `buildTempoRequest(tempoToken: string, userConfiguredProxy: string, path: string, params?: URLSearchParams, options?: { supabaseAccessToken?: string | null }): { url: string; headers: Record<string, string> }`
  - `path` is relative to `https://api.tempo.io/4/` (e.g. `worklogs/user/acc-1`).

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bridge from '../proxyUrlBridge';
import { buildTempoRequest, getTempoGatewayMode } from '../tempoGateway';

afterEach(() => vi.restoreAllMocks());

function stubBridge(state: Partial<ReturnType<typeof bridge.getProxyOverrideState>>) {
	vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
		hostedProxyUrl: null, userOverride: false, supabaseAccessToken: null, ...state,
	});
}

describe('getTempoGatewayMode', () => {
	it('hosted when a hosted proxy is set and not overridden', () => {
		stubBridge({ hostedProxyUrl: 'https://app.example.com/api/proxy' });
		expect(getTempoGatewayMode('')).toBe('hosted');
	});
	it('self-hosted when a user proxy is set', () => {
		stubBridge({});
		expect(getTempoGatewayMode('https://proxy.me')).toBe('self-hosted');
	});
	it('direct when nothing is configured', () => {
		stubBridge({});
		expect(getTempoGatewayMode('')).toBe('direct');
	});
});

describe('buildTempoRequest', () => {
	it('hosted: token in X-Tempo-Token header, never in URL', () => {
		stubBridge({ hostedProxyUrl: 'https://app.example.com/api/proxy', supabaseAccessToken: 'jwt' });
		const { url, headers } = buildTempoRequest('secret', '', 'worklogs/user/acc-1', new URLSearchParams({ from: '2026-06-01' }));
		expect(url).toBe('https://app.example.com/api/tempo?path=worklogs%2Fuser%2Facc-1&from=2026-06-01');
		expect(headers['x-tempo-token']).toBe('secret');
		expect(headers.authorization).toBe('Bearer jwt');
		expect(url).not.toContain('secret');
	});
	it('self-hosted: token in Authorization, upstream URL proxied', () => {
		stubBridge({});
		const { url, headers } = buildTempoRequest('secret', 'https://proxy.me/', 'worklogs', new URLSearchParams({ from: '2026-06-01' }));
		expect(url).toBe('https://proxy.me/https://api.tempo.io/4/worklogs?from=2026-06-01');
		expect(headers.authorization).toBe('Bearer secret');
	});
	it('direct: hits api.tempo.io with bearer token', () => {
		stubBridge({});
		const { url } = buildTempoRequest('secret', '', 'worklogs', new URLSearchParams());
		expect(url).toBe('https://api.tempo.io/4/worklogs');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/services/__tests__/tempoGateway.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontend/services/tempoGateway.ts`**

```ts
/**
 * Single seam for routing Tempo Cloud API requests through the right gateway.
 *
 * `api.tempo.io` sends no browser CORS headers, so the browser can only reach it
 * through *some* server. Three modes mirror the RescueTime gateway:
 *   1. `hosted`      — Premium relay at `${origin}/api/tempo`. The Tempo token
 *                      travels in `X-Tempo-Token` and becomes the upstream
 *                      `Authorization: Bearer` server-side, never in a browser URL.
 *   2. `self-hosted` — user CORS proxy: `${proxy}/https://api.tempo.io/4/<path>`.
 *   3. `direct`      — would CORS-fail; callers check the mode first and fail fast.
 */
import { getProxyOverrideState } from './proxyUrlBridge';

const TEMPO_BASE = 'https://api.tempo.io/4';

export type TempoGatewayMode = 'hosted' | 'self-hosted' | 'direct';

export function getTempoGatewayMode(userConfiguredProxy: string): TempoGatewayMode {
	const { hostedProxyUrl, userOverride } = getProxyOverrideState();
	if (hostedProxyUrl && !userOverride) return 'hosted';
	return userConfiguredProxy.trim() ? 'self-hosted' : 'direct';
}

export interface TempoRequestPieces {
	url: string;
	headers: Record<string, string>;
}

export function buildTempoRequest(
	tempoToken: string,
	userConfiguredProxy: string,
	path: string,
	params: URLSearchParams = new URLSearchParams(),
	options: { supabaseAccessToken?: string | null } = {},
): TempoRequestPieces {
	const bridge = getProxyOverrideState();
	const { hostedProxyUrl, userOverride } = bridge;
	const cleanPath = path.replace(/^\/+/, '');

	if (hostedProxyUrl && !userOverride) {
		// Hosted: token in a header. The relay reads `path` from the query and
		// rebuilds the upstream URL, so we pass `path` as a query param.
		const endpoint = hostedTempoEndpoint(hostedProxyUrl);
		const merged = new URLSearchParams({ path: cleanPath });
		for (const [k, v] of params) merged.append(k, v);
		const token = options.supabaseAccessToken ?? bridge.supabaseAccessToken;
		const headers: Record<string, string> = { 'x-tempo-token': tempoToken };
		if (token) headers.authorization = `Bearer ${token}`;
		const qs = merged.toString();
		return { url: qs ? `${endpoint}?${qs}` : endpoint, headers };
	}

	const qs = params.toString();
	const upstream = `${TEMPO_BASE}/${cleanPath}${qs ? `?${qs}` : ''}`;
	const proxy = userConfiguredProxy.trim().replace(/\/$/, '');
	const url = proxy ? `${proxy}/${upstream}` : upstream;
	return { url, headers: { authorization: `Bearer ${tempoToken}` } };
}

/** Derive the sibling `/api/tempo` endpoint from the hosted proxy base. */
function hostedTempoEndpoint(hostedProxyUrl: string): string {
	const trimmed = hostedProxyUrl.replace(/\/+$/, '');
	const suffix = '/api/proxy';
	return trimmed.endsWith(suffix)
		? `${trimmed.slice(0, -suffix.length)}/api/tempo`
		: `${trimmed}/api/tempo`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/services/__tests__/tempoGateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/services/tempoGateway.ts frontend/services/__tests__/tempoGateway.test.ts
git commit -m "feat(tempo): 3-mode tempoGateway request builder"
```

---

## Task 4: `worklogSource` — resolver + detection predicate

**Files:**
- Create: `frontend/services/worklogSource.ts`
- Test: `frontend/services/__tests__/worklogSource.test.ts`

**Interfaces:**
- Consumes: `JiraUser` (`types/jira.ts`).
- Produces:
  - `looksLikeTempoManaged(authors: Array<{ accountType?: string; displayName?: string } | undefined>): boolean`
  - `getWorklogSource(input: { tempoMode: 'auto'|'jira'|'tempo'; tempoApiToken: string; tempoSuspected: boolean }): 'jira' | 'tempo'`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { getWorklogSource, looksLikeTempoManaged } from '../worklogSource';

describe('looksLikeTempoManaged', () => {
	it('true for an app-account author', () => {
		expect(looksLikeTempoManaged([{ accountType: 'app', displayName: 'Timesheets by Tempo' }])).toBe(true);
	});
	it('true for a Tempo display name even without accountType', () => {
		expect(looksLikeTempoManaged([{ displayName: 'Tempo Timesheets' }])).toBe(true);
	});
	it('false for ordinary human authors', () => {
		expect(looksLikeTempoManaged([{ accountType: 'atlassian', displayName: 'Ana' }])).toBe(false);
	});
	it('false for an empty list', () => {
		expect(looksLikeTempoManaged([])).toBe(false);
	});
});

describe('getWorklogSource', () => {
	const base = { tempoApiToken: '', tempoSuspected: false };
	it('auto + no token → jira', () => {
		expect(getWorklogSource({ ...base, tempoMode: 'auto' })).toBe('jira');
	});
	it('auto + token + suspected → tempo', () => {
		expect(getWorklogSource({ tempoMode: 'auto', tempoApiToken: 't', tempoSuspected: true })).toBe('tempo');
	});
	it('auto + token + not suspected → jira', () => {
		expect(getWorklogSource({ tempoMode: 'auto', tempoApiToken: 't', tempoSuspected: false })).toBe('jira');
	});
	it('tempo + token → tempo', () => {
		expect(getWorklogSource({ tempoMode: 'tempo', tempoApiToken: 't', tempoSuspected: false })).toBe('tempo');
	});
	it('tempo + no token → jira (token required)', () => {
		expect(getWorklogSource({ tempoMode: 'tempo', tempoApiToken: '', tempoSuspected: true })).toBe('jira');
	});
	it('jira always → jira', () => {
		expect(getWorklogSource({ tempoMode: 'jira', tempoApiToken: 't', tempoSuspected: true })).toBe('jira');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/services/__tests__/worklogSource.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontend/services/worklogSource.ts`**

```ts
/**
 * Decides whether worklog reads/writes use native Jira or Tempo, and a passive
 * predicate that detects Tempo-managed instances from worklog authors.
 */

/** True if any author looks like the Tempo app account (no human email). */
export function looksLikeTempoManaged(
	authors: Array<{ accountType?: string; displayName?: string } | undefined>,
): boolean {
	return authors.some(
		(a) =>
			a?.accountType === 'app' || /tempo/i.test(a?.displayName ?? ''),
	);
}

export interface WorklogSourceInput {
	tempoMode: 'auto' | 'jira' | 'tempo';
	tempoApiToken: string;
	tempoSuspected: boolean;
}

export function getWorklogSource(input: WorklogSourceInput): 'jira' | 'tempo' {
	const hasToken = input.tempoApiToken.trim().length > 0;
	if (input.tempoMode === 'jira') return 'jira';
	if (input.tempoMode === 'tempo') return hasToken ? 'tempo' : 'jira';
	// auto
	return hasToken && input.tempoSuspected ? 'tempo' : 'jira';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/services/__tests__/worklogSource.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/services/worklogSource.ts frontend/services/__tests__/worklogSource.test.ts
git commit -m "feat(tempo): worklog source resolver + Tempo detection predicate"
```

---

## Task 5: `tempoMapper` — pure mapping + chunked issue enrichment

**Files:**
- Create: `frontend/services/tempoMapper.ts`
- Test: `frontend/services/__tests__/tempoMapper.test.ts`

**Interfaces:**
- Consumes: `EnrichedJiraWorklog`, `JiraIssue` (`types/jira.ts`); `searchAllIssues` (`jiraSearch.ts`).
- Produces:
  - `interface TempoWorklog { tempoWorklogId: number; jiraWorklogId?: number; issue: { id: number }; timeSpentSeconds: number; startDate: string; startTime?: string; description?: string; author?: { accountId?: string } }`
  - `mapTempoWorklog(wl: TempoWorklog, issueMap: Map<string, JiraIssue>, email: string): EnrichedJiraWorklog`
  - `fetchIssueMetadata(ids: string[], config, signal?): Promise<Map<string, JiraIssue>>` (chunked, ~100 ids/query)
  - `placeholderIssue(id: string): JiraIssue`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import type { JiraIssue } from '../../../types/jira';
import { chunkIds, mapTempoWorklog, placeholderIssue } from '../tempoMapper';

const issue: JiraIssue = { id: '1001', key: 'PAY-1', fields: { summary: 'Do thing' } };

describe('mapTempoWorklog', () => {
	it('maps a Tempo worklog onto EnrichedJiraWorklog with a known issue', () => {
		const out = mapTempoWorklog(
			{ tempoWorklogId: 55, issue: { id: 1001 }, timeSpentSeconds: 3600, startDate: '2026-06-05', startTime: '08:00:00', description: 'work' },
			new Map([['1001', issue]]),
			'me@x.com',
		);
		expect(out.id).toBe('55');
		expect(out.issue.key).toBe('PAY-1');
		expect(out.timeSpentSeconds).toBe(3600);
		expect(out.comment).toBe('work');
		expect(out.started).toBe('2026-06-05T08:00:00');
		expect(out.author?.emailAddress).toBe('me@x.com');
	});

	it('defaults startTime and uses startDate as the day basis', () => {
		const out = mapTempoWorklog(
			{ tempoWorklogId: 7, issue: { id: 1001 }, timeSpentSeconds: 60, startDate: '2026-06-30' },
			new Map([['1001', issue]]),
			'me@x.com',
		);
		expect(out.started).toBe('2026-06-30T00:00:00');
	});

	it('uses a placeholder issue when the id is not in the map (never drops)', () => {
		const out = mapTempoWorklog(
			{ tempoWorklogId: 9, issue: { id: 2002 }, timeSpentSeconds: 60, startDate: '2026-06-05' },
			new Map(),
			'me@x.com',
		);
		expect(out.issue.key).toBe('UNKNOWN-2002');
		expect(out.issue.fields.summary).toContain('Unknown issue');
	});
});

describe('chunkIds', () => {
	it('splits into chunks of the given size', () => {
		expect(chunkIds(['1', '2', '3'], 2)).toEqual([['1', '2'], ['3']]);
	});
	it('returns no chunks for an empty list', () => {
		expect(chunkIds([], 100)).toEqual([]);
	});
});

describe('placeholderIssue', () => {
	it('builds a stable placeholder', () => {
		expect(placeholderIssue('42')).toMatchObject({ id: '42', key: 'UNKNOWN-42' });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/services/__tests__/tempoMapper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontend/services/tempoMapper.ts`**

```ts
import type { EnrichedJiraWorklog, JiraIssue } from '../../types/jira';
import { searchAllIssues } from './jiraSearch';

export interface TempoWorklog {
	tempoWorklogId: number;
	jiraWorklogId?: number;
	issue: { id: number };
	timeSpentSeconds: number;
	startDate: string;
	startTime?: string;
	description?: string;
	author?: { accountId?: string };
}

export function placeholderIssue(id: string): JiraIssue {
	return { id, key: `UNKNOWN-${id}`, fields: { summary: `Unknown issue · ${id}` } };
}

/**
 * Map a Tempo worklog onto the app's `EnrichedJiraWorklog`. The day basis is
 * Tempo's `startDate` (already the worker's wall clock); `started` is synthesized
 * only so `worklogMonth()`/`new Date()` consumers keep working. `author` is
 * synthesized with the current user's email so downstream email grouping works.
 */
export function mapTempoWorklog(
	wl: TempoWorklog,
	issueMap: Map<string, JiraIssue>,
	email: string,
): EnrichedJiraWorklog {
	const issueId = String(wl.issue.id);
	const issue = issueMap.get(issueId) ?? placeholderIssue(issueId);
	const started = `${wl.startDate}T${wl.startTime ?? '00:00:00'}`;
	return {
		id: String(wl.tempoWorklogId),
		issueId,
		started,
		created: started,
		timeSpentSeconds: wl.timeSpentSeconds,
		comment: wl.description ?? '',
		author: { accountId: wl.author?.accountId, emailAddress: email },
		issue,
	};
}

export function chunkIds(ids: string[], size: number): string[][] {
	const out: string[][] = [];
	for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
	return out;
}

/**
 * Fetch Jira issue metadata for the given numeric issue ids, in chunks of 100 to
 * stay under JQL/URL limits. Missing issues are simply absent from the map; the
 * mapper substitutes a placeholder so the worklog is never dropped.
 */
export async function fetchIssueMetadata(
	ids: string[],
	config: Parameters<typeof searchAllIssues>[0],
	signal?: AbortSignal,
): Promise<Map<string, JiraIssue>> {
	const map = new Map<string, JiraIssue>();
	for (const chunk of chunkIds([...new Set(ids)], 100)) {
		if (chunk.length === 0) continue;
		const jql = `issue in (${chunk.join(',')})`;
		const issues = await searchAllIssues<JiraIssue>(
			config,
			{ jql, fields: 'key,summary,issuetype,parent,project,status', maxResults: 100 },
			{ signal },
		);
		for (const issue of issues) map.set(String(issue.id), issue);
	}
	return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/services/__tests__/tempoMapper.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/services/tempoMapper.ts frontend/services/__tests__/tempoMapper.test.ts
git commit -m "feat(tempo): pure worklog mapper + chunked issue enrichment"
```

---

## Task 6: `tempoWorklogService` — week + month reads

**Files:**
- Create: `frontend/services/tempoWorklogService.ts`
- Test: `frontend/services/__tests__/tempoWorklogService.test.ts`

**Interfaces:**
- Consumes: `resolveAccountId` (Task 2), `buildTempoRequest`/`getTempoGatewayMode` (Task 3), `mapTempoWorklog`/`fetchIssueMetadata` (Task 5), `WorklogEntry` (`worklogService.ts`).
- Produces:
  - `fetchMonthWorklogsTempo(config, year, month, signal?): Promise<EnrichedJiraWorklog[]>`
  - `fetchWeekWorklogsTempo(config, weekStart, weekEnd, signal?): Promise<WorklogEntry[]>`
  - Both fail the whole read (throw) if the Tempo fetch fails; issue-enrichment gaps degrade to placeholders.

- [ ] **Step 1: Write the failing test** (covers the original regression: app-account worklogs now appear)

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bridge from '../proxyUrlBridge';
import { __resetIdentityCache } from '../jiraIdentity';
import { fetchMonthWorklogsTempo } from '../tempoWorklogService';

const config = { jiraHost: 'x.atlassian.net', email: 'me@x.com', apiToken: 't', corsProxy: '', tempoApiToken: 'tempo-tok' };

afterEach(() => { vi.restoreAllMocks(); __resetIdentityCache(); });

function routeFetch(handlers: { myself?: object; tempo?: object; jiraSearch?: object }) {
	vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({ hostedProxyUrl: null, userOverride: false, supabaseAccessToken: null });
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		if (url.includes('/myself')) return new Response(JSON.stringify(handlers.myself ?? { accountId: 'acc-1' }), { status: 200 });
		if (url.includes('api.tempo.io')) return new Response(JSON.stringify(handlers.tempo), { status: 200 });
		if (url.includes('/search/jql')) return new Response(JSON.stringify(handlers.jiraSearch), { status: 200 });
		throw new Error(`unexpected url ${url}`);
	}));
}

describe('fetchMonthWorklogsTempo', () => {
	it('returns Tempo worklogs (authored by the Tempo app) enriched with Jira issue metadata', async () => {
		routeFetch({
			tempo: { results: [{ tempoWorklogId: 55, issue: { id: 1001 }, timeSpentSeconds: 3600, startDate: '2026-06-05', startTime: '08:00:00', description: 'work', author: { accountId: 'acc-1' } }], metadata: {} },
			jiraSearch: { issues: [{ id: '1001', key: 'PAY-1', fields: { summary: 'Do thing' } }], isLast: true },
		});
		const out = await fetchMonthWorklogsTempo(config, 2026, 5, undefined); // month is 0-indexed → June
		expect(out).toHaveLength(1);
		expect(out[0].issue.key).toBe('PAY-1');
		expect(out[0].timeSpentSeconds).toBe(3600);
	});

	it('follows metadata.next pagination', async () => {
		let page = 0;
		vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({ hostedProxyUrl: null, userOverride: false, supabaseAccessToken: null });
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			if (url.includes('/myself')) return new Response(JSON.stringify({ accountId: 'acc-1' }), { status: 200 });
			if (url.includes('api.tempo.io')) {
				page += 1;
				return page === 1
					? new Response(JSON.stringify({ results: [{ tempoWorklogId: 1, issue: { id: 1001 }, timeSpentSeconds: 60, startDate: '2026-06-05' }], metadata: { next: 'https://api.tempo.io/4/worklogs/user/acc-1?offset=50' } }), { status: 200 })
					: new Response(JSON.stringify({ results: [{ tempoWorklogId: 2, issue: { id: 1001 }, timeSpentSeconds: 60, startDate: '2026-06-06' }], metadata: {} }), { status: 200 });
			}
			if (url.includes('/search/jql')) return new Response(JSON.stringify({ issues: [{ id: '1001', key: 'PAY-1', fields: {} }], isLast: true }), { status: 200 });
			throw new Error(url);
		}));
		const out = await fetchMonthWorklogsTempo(config, 2026, 5, undefined);
		expect(out).toHaveLength(2);
	});

	it('throws when the Tempo fetch fails (no silent undercount)', async () => {
		vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({ hostedProxyUrl: null, userOverride: false, supabaseAccessToken: null });
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			if (url.includes('/myself')) return new Response(JSON.stringify({ accountId: 'acc-1' }), { status: 200 });
			return new Response('boom', { status: 500 });
		}));
		await expect(fetchMonthWorklogsTempo(config, 2026, 5, undefined)).rejects.toMatchObject({ kind: 'server-error' });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/services/__tests__/tempoWorklogService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontend/services/tempoWorklogService.ts`**

```ts
import type { EnrichedJiraWorklog } from '../../types/jira';
import { resolveAccountId } from './jiraIdentity';
import { fromHttpResponse, fromNetworkError } from './serviceErrors';
import { buildTempoRequest } from './tempoGateway';
import {
	type TempoWorklog,
	fetchIssueMetadata,
	mapTempoWorklog,
} from './tempoMapper';
import type { WorklogEntry } from './worklogService';

export interface TempoServiceConfig {
	jiraHost: string;
	email: string;
	apiToken: string;
	corsProxy: string;
	tempoApiToken: string;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

interface TempoPage {
	results: TempoWorklog[];
	metadata?: { next?: string };
}

/** Fetch every Tempo worklog for the user + range, following `metadata.next`. */
async function fetchAllTempoWorklogs(
	config: TempoServiceConfig,
	accountId: string,
	from: string,
	to: string,
	signal?: AbortSignal,
): Promise<TempoWorklog[]> {
	const all: TempoWorklog[] = [];
	let params: URLSearchParams | null = new URLSearchParams({ from, to, limit: '1000' });
	let path = `worklogs/user/${accountId}`;

	while (params) {
		const { url, headers } = buildTempoRequest(
			config.tempoApiToken,
			config.corsProxy,
			path,
			params,
		);
		let res: Response;
		try {
			res = await fetch(url, { headers, signal });
		} catch (err) {
			throw fromNetworkError('Tempo worklogs', err);
		}
		if (!res.ok) throw fromHttpResponse('Tempo worklogs', res.status);
		const page = (await res.json()) as TempoPage;
		all.push(...(page.results ?? []));

		const next = page.metadata?.next;
		if (!next) break;
		// `next` is an absolute api.tempo.io URL; re-extract path + query so the
		// gateway re-wraps it for the active mode rather than calling it raw.
		const u = new URL(next);
		path = u.pathname.replace(/^\/4\//, '');
		params = u.searchParams;
	}
	return all;
}

async function enrichAndMap(
	config: TempoServiceConfig,
	worklogs: TempoWorklog[],
	signal?: AbortSignal,
): Promise<EnrichedJiraWorklog[]> {
	const ids = worklogs.map((w) => String(w.issue.id));
	const issueMap = await fetchIssueMetadata(ids, config, signal);
	return worklogs.map((w) => mapTempoWorklog(w, issueMap, config.email));
}

export async function fetchMonthWorklogsTempo(
	config: TempoServiceConfig,
	year: number,
	month: number, // 0-indexed
	signal?: AbortSignal,
): Promise<EnrichedJiraWorklog[]> {
	if (!config.jiraHost || !config.apiToken || !config.tempoApiToken) return [];
	const accountId = await resolveAccountId(config, signal);
	const daysInMonth = new Date(year, month + 1, 0).getDate();
	const from = `${year}-${pad(month + 1)}-01`;
	const to = `${year}-${pad(month + 1)}-${pad(daysInMonth)}`;
	const worklogs = await fetchAllTempoWorklogs(config, accountId, from, to, signal);
	return enrichAndMap(config, worklogs, signal);
}

export async function fetchWeekWorklogsTempo(
	config: TempoServiceConfig,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
): Promise<WorklogEntry[]> {
	if (!config.jiraHost || !config.apiToken || !config.tempoApiToken) return [];
	const accountId = await resolveAccountId(config, signal);
	const worklogs = await fetchAllTempoWorklogs(config, accountId, weekStart, weekEnd, signal);
	const enriched = await enrichAndMap(config, worklogs, signal);
	return enriched
		.filter((wl) => {
			const day = (wl.started ?? '').slice(0, 10);
			return day >= weekStart && day <= weekEnd;
		})
		.map((wl) => ({
			date: (wl.started ?? '').slice(0, 10),
			issueKey: wl.issue.key,
			issueSummary: wl.issue.fields.summary,
			timeSpentSeconds: wl.timeSpentSeconds ?? 0,
		}));
}
```

> Confirm Tempo's list response field name (`results`) and the pagination cursor (`metadata.next`) against the live v4 docs; adjust the `TempoPage` interface + `next` handling if they differ.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/services/__tests__/tempoWorklogService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/services/tempoWorklogService.ts frontend/services/__tests__/tempoWorklogService.test.ts
git commit -m "feat(tempo): week + month worklog reads via Tempo API"
```

---

## Task 7: `tempoSuspected` UI flag + Jira-side detection

**Files:**
- Modify: `frontend/stores/useUIStore.ts` (add `tempoSuspected: boolean` + `setTempoSuspected`)
- Modify: `frontend/services/worklogService.ts` (set the flag), `frontend/services/monthWorklogService.ts` (set the flag)
- Test: `frontend/stores/__tests__/useUIStore.test.ts`

**Interfaces:**
- Consumes: `looksLikeTempoManaged` (Task 4).
- Produces: `useUIStore().tempoSuspected` + `setTempoSuspected(v: boolean)`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/stores/__tests__/useUIStore.test.ts`:

```ts
it('tracks tempoSuspected (default false)', () => {
	expect(useUIStore.getState().tempoSuspected).toBe(false);
	useUIStore.getState().setTempoSuspected(true);
	expect(useUIStore.getState().tempoSuspected).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/stores/__tests__/useUIStore.test.ts`
Expected: FAIL — `tempoSuspected`/`setTempoSuspected` undefined.

- [ ] **Step 3: Implement**

In `useUIStore.ts`, add `tempoSuspected: false` to the initial state and a setter:

```ts
	tempoSuspected: false,
	setTempoSuspected: (v: boolean) => set({ tempoSuspected: v }),
```

(Add `tempoSuspected: boolean` and `setTempoSuspected: (v: boolean) => void` to the store's TS interface.)

In `frontend/services/worklogService.ts`, after the search returns `issues` (around line 65), before the per-issue loop, collect the embedded authors and set the flag:

```ts
import { useUIStore } from '../stores/useUIStore';
import { looksLikeTempoManaged } from './worklogSource';
// …
const authors = issues.flatMap((i) => i.fields.worklog?.worklogs?.map((w) => w.author) ?? []);
if (looksLikeTempoManaged(authors)) useUIStore.getState().setTempoSuspected(true);
```

Apply the equivalent in `monthWorklogService.ts` after its `searchAllIssues` call (it already has `issue.fields.worklog`). Reading the store outside React via `getState()` is the established pattern (see `useWorklogOperations.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/stores/__tests__/useUIStore.test.ts`
Expected: PASS. Then run `npx vitest run frontend/services/__tests__/monthWorklogService.test.ts` to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add frontend/stores/useUIStore.ts frontend/stores/__tests__/useUIStore.test.ts frontend/services/worklogService.ts frontend/services/monthWorklogService.ts
git commit -m "feat(tempo): detect Tempo-managed instances from worklog authors"
```

---

## Task 8: Route read hooks through the resolver

**Files:**
- Modify: `frontend/react/hooks/useMonthWorklogs.ts` (the month read; ~lines 53-153)
- Modify: `frontend/react/hooks/useTimesheetDataFetcher.ts` (the week read caller of `fetchWeekWorklogs`)
- Test: `frontend/react/hooks/__tests__/useMonthWorklogs.test.tsx` (create if absent) or extend an existing month-hook test

**Interfaces:**
- Consumes: `getWorklogSource` (Task 4), `fetchMonthWorklogsTempo`/`fetchWeekWorklogsTempo` (Task 6), `useConfigStore`, `useUIStore`.
- Produces: same hook return shapes as today (no API change for components).

- [ ] **Step 1: Write the failing test**

Create `frontend/react/hooks/__tests__/worklogSourceRouting.test.ts` to assert the routing decision the hook will use (pure, no React):

```ts
import { describe, expect, it, vi } from 'vitest';
import { getWorklogSource } from '../../../services/worklogSource';
import * as tempo from '../../../services/tempoWorklogService';
import * as jira from '../../../services/monthWorklogService';

describe('month read routing', () => {
	it('calls Tempo when source resolves to tempo', async () => {
		const tempoSpy = vi.spyOn(tempo, 'fetchMonthWorklogsTempo').mockResolvedValue([]);
		const jiraSpy = vi.spyOn(jira, 'fetchMonthWorklogs').mockResolvedValue([]);
		const source = getWorklogSource({ tempoMode: 'tempo', tempoApiToken: 't', tempoSuspected: false });
		// the routing helper the hook uses:
		const { readMonth } = await import('../worklogReadRouter');
		await readMonth(source, { jiraHost: 'h', email: 'e', apiToken: 'a', corsProxy: '', tempoApiToken: 't' } as never, 2026, 5);
		expect(tempoSpy).toHaveBeenCalled();
		expect(jiraSpy).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/react/hooks/__tests__/worklogSourceRouting.test.ts`
Expected: FAIL — `worklogReadRouter` not found.

- [ ] **Step 3: Implement a tiny router + wire the hooks**

Create `frontend/react/hooks/worklogReadRouter.ts` (keeps the branch out of the hook body and unit-testable):

```ts
import { fetchMonthWorklogs } from '../../services/monthWorklogService';
import type { FetchMonthOptions } from '../../services/monthWorklogService';
import { fetchMonthWorklogsTempo } from '../../services/tempoWorklogService';
import { fetchWeekWorklogs } from '../../services/worklogService';
import { fetchWeekWorklogsTempo } from '../../services/tempoWorklogService';

export function readMonth(
	source: 'jira' | 'tempo',
	config: never,
	year: number,
	month: number,
	options?: FetchMonthOptions,
	signal?: AbortSignal,
) {
	return source === 'tempo'
		? fetchMonthWorklogsTempo(config, year, month, signal)
		: fetchMonthWorklogs(config, year, month, options, signal);
}

export function readWeek(
	source: 'jira' | 'tempo',
	config: never,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
) {
	return source === 'tempo'
		? fetchWeekWorklogsTempo(config, weekStart, weekEnd, signal)
		: fetchWeekWorklogs(config, weekStart, weekEnd, signal);
}
```

In `useMonthWorklogs.ts`, compute the source once from the stores and call `readMonth` instead of `fetchMonthWorklogs` directly:

```ts
import { getWorklogSource } from '../../services/worklogSource';
import { useUIStore } from '../../stores/useUIStore';
import { readMonth } from './worklogReadRouter';
// inside the hook:
const config = useConfigStore((s) => s.config);
const tempoSuspected = useUIStore((s) => s.tempoSuspected);
const source = getWorklogSource({
	tempoMode: config.tempoMode,
	tempoApiToken: config.tempoApiToken,
	tempoSuspected,
});
// replace each fetchMonthWorklogs(config, year, month, opts, signal) with:
readMonth(source, config, year, month, opts, signal)
```

> Note: when `source === 'tempo'`, `readMonth` ignores `opts.currentUserOnly`/`opts.jqlFilter` (Tempo is inherently user-scoped). Keep passing `opts` so the Jira path is unchanged; the Tempo path drops them by signature.

Apply the equivalent `readWeek` swap wherever `useTimesheetDataFetcher.ts` calls `fetchWeekWorklogs`. Add the source to the TanStack Query `queryKey` (e.g. append `source`) so switching source refetches rather than serving a stale cross-source cache.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/react/hooks/__tests__/worklogSourceRouting.test.ts`
Then the full suite: `npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add frontend/react/hooks/worklogReadRouter.ts frontend/react/hooks/__tests__/worklogSourceRouting.test.ts frontend/react/hooks/useMonthWorklogs.ts frontend/react/hooks/useTimesheetDataFetcher.ts
git commit -m "feat(tempo): route worklog reads through the source resolver"
```

---

## Task 9: Hosted relay endpoint `/api/tempo` (read methods)

**Files:**
- Create: `premium/api/_lib/tempoForward.ts`
- Create: `premium/api/tempo/index.ts`
- Create: `api/tempo/index.ts` (free-tier build's stub/mirror, matching how `api/rescuetime` mirrors `premium/api/rescuetime`)
- Test: `premium/api/_lib/__tests__/tempoForward.test.ts`

**Interfaces:**
- Mirror `premium/api/_lib/rescueTimeForward.ts` + `premium/api/rescuetime/`. Read the existing RescueTime relay first and follow its auth/entitlement + error-mapping shape exactly.
- Produces: an endpoint that takes `?path=<tempo-path>&<params>` + `X-Tempo-Token` + `Authorization: Bearer <supabaseJwt>`, verifies entitlement, and forwards to `https://api.tempo.io/4/<path>` with `Authorization: Bearer <tempoToken>`.

- [ ] **Step 1: Write the failing test** (model on `premium/api/_lib/__tests__/rescueTimeForward.test.ts`)

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardToTempo } from '../tempoForward';

afterEach(() => vi.restoreAllMocks());

describe('forwardToTempo', () => {
	it('forwards GET to the upstream path with the tempo bearer token', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const res = await forwardToTempo({ path: 'worklogs/user/acc-1', search: 'from=2026-06-01', tempoToken: 'tok', method: 'GET' });
		expect(res.status).toBe(200);
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toBe('https://api.tempo.io/4/worklogs/user/acc-1?from=2026-06-01');
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
	});

	it('maps an upstream network failure to 502', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND api.tempo.io'); }));
		const res = await forwardToTempo({ path: 'worklogs', search: '', tempoToken: 'tok', method: 'GET' });
		expect(res.status).toBe(502);
	});

	it('rejects a path that escapes the /4/ namespace', async () => {
		const res = await forwardToTempo({ path: '../secret', search: '', tempoToken: 'tok', method: 'GET' });
		expect(res.status).toBe(400);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run premium/api/_lib/__tests__/tempoForward.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `premium/api/_lib/tempoForward.ts`**

```ts
const TEMPO_BASE = 'https://api.tempo.io/4';

export interface ForwardOptions {
	path: string;
	search: string;
	tempoToken: string;
	method: string;
	body?: string;
}

/** Reject paths that try to escape the /4/ namespace. */
function isSafePath(path: string): boolean {
	return !path.includes('..') && !path.startsWith('/') && !path.includes('://');
}

export async function forwardToTempo(opts: ForwardOptions): Promise<Response> {
	const cleanPath = opts.path.replace(/^\/+/, '');
	if (!isSafePath(cleanPath)) {
		return new Response(JSON.stringify({ error: 'bad_path' }), { status: 400 });
	}
	const url = `${TEMPO_BASE}/${cleanPath}${opts.search ? `?${opts.search}` : ''}`;
	const headers: Record<string, string> = {
		authorization: `Bearer ${opts.tempoToken}`,
		accept: 'application/json',
	};
	if (opts.body) headers['content-type'] = 'application/json';
	try {
		const upstream = await fetch(url, { method: opts.method, headers, body: opts.body });
		const text = await upstream.text();
		return new Response(text, {
			status: upstream.status,
			headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
		});
	} catch {
		return new Response(JSON.stringify({ error: 'upstream_unreachable' }), { status: 502 });
	}
}
```

Then create `premium/api/tempo/index.ts` (the route handler): read `path` + remaining params from the query, read `X-Tempo-Token`, verify the Supabase JWT + entitlement exactly as `premium/api/rescuetime/index.ts` does, then call `forwardToTempo`. Create `api/tempo/index.ts` mirroring `api/rescuetime/index.ts`. **Restrict methods to `GET` in Plan 1** (Plan 2 adds `POST/PUT/DELETE`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run premium/api/_lib/__tests__/tempoForward.test.ts`
Then: `node scripts/check-premium-boundary.cjs`
Expected: tests PASS; boundary check passes.

- [ ] **Step 5: Commit**

```bash
git add premium/api/_lib/tempoForward.ts premium/api/_lib/__tests__/tempoForward.test.ts premium/api/tempo/index.ts api/tempo/index.ts
git commit -m "feat(tempo): hosted relay endpoint for Tempo reads"
```

---

## Task 10: Settings UI — token, mode, test-connection, detection banner

**Files:**
- Modify: the Settings component that renders the RescueTime/integrations section (find via `grep -rn "rescueTimeApiKey" frontend/react`); add a Tempo subsection beside it.
- Create: `frontend/react/components/settings/TempoConnectBanner.tsx` (the detection banner)
- Test: `frontend/react/components/settings/__tests__/TempoSettings.test.tsx`

**Interfaces:**
- Consumes: `useConfigStore` (`tempoApiToken`, `tempoMode`), `useUIStore` (`tempoSuspected`), `buildTempoRequest`/`getTempoGatewayMode` (Task 3), `describeServiceError` (`serviceErrors.ts`).
- Produces: UI to set `tempoApiToken` + `tempoMode`, a "Test connection" button, and a banner shown when `tempoSuspected && !tempoApiToken`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TempoConnectBanner } from '../TempoConnectBanner';

describe('TempoConnectBanner', () => {
	it('renders a connect prompt when shown', () => {
		render(<TempoConnectBanner show onConnect={() => {}} />);
		expect(screen.getByText(/logs time through Tempo/i)).toBeInTheDocument();
	});
	it('renders nothing when show is false', () => {
		const { container } = render(<TempoConnectBanner show={false} onConnect={() => {}} />);
		expect(container).toBeEmptyDOMElement();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/react/components/settings/__tests__/TempoSettings.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement**

`frontend/react/components/settings/TempoConnectBanner.tsx`:

```tsx
interface Props {
	show: boolean;
	onConnect: () => void;
}

export function TempoConnectBanner({ show, onConnect }: Props) {
	if (!show) return null;
	return (
		<div role="alert" className="tempo-connect-banner">
			<span>This Jira logs time through Tempo. Connect Tempo to see and edit your worklogs.</span>
			<button type="button" onClick={onConnect}>Connect Tempo</button>
		</div>
	);
}
```

In the Settings integrations section, add (mirroring the RescueTime field):
- a text input bound to `config.tempoApiToken` (via the config store's setter),
- a select bound to `config.tempoMode` with options `auto` / `tempo` / `jira` labelled "Auto-detect" / "Always use Tempo" / "Always use Jira",
- a "Test connection" button calling `buildTempoRequest(config.tempoApiToken, config.corsProxy, 'worklogs', new URLSearchParams({ limit: '1' }))` → `fetch` → on non-ok, show `describeServiceError(...).message`; on ok, show "Connected".

Render `<TempoConnectBanner show={tempoSuspected && !config.tempoApiToken.trim()} onConnect={scrollToTempoSection} />` on the timesheet view's settings entry point.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/react/components/settings/__tests__/TempoSettings.test.tsx`
Then full suite + typecheck: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/react/components/settings/TempoConnectBanner.tsx frontend/react/components/settings/__tests__/TempoSettings.test.tsx frontend/react/<settings-component-touched>
git commit -m "feat(tempo): settings token + mode + test-connection + detect banner"
```

---

## Plan 1 Done — verification

- [ ] `npx vitest run` — full unit suite green (was 1034 passing; now higher).
- [ ] `npm run typecheck` — clean.
- [ ] `node scripts/check-premium-boundary.cjs` — passes.
- [ ] Manual: on a Tempo instance, the month/week views now show the current user's worklogs (the original bug).

## Deferred to later plans

- **Plan 2 — Writes:** `tempoWriteService` (create/update/delete/getWorklog), branch `useWorklogOperations`, relay `POST/PUT/DELETE`, issueId resolution via the existing validation GET, `parseTimeSpentToSeconds`/`formatJiraTimeSpent`.
- **Plan 3 — Team reads:** non-user-scoped `GET /4/worklogs`, accountId→human mapping via Jira user lookup, wire `currentUserOnly=false` month path + Reports/`teamReports`.
