# GitHub-driven worklog suggestions (dev-status + Events hybrid)

**Date:** 2026-06-23 · **Status:** approved

## Problem

Hoursmith mines a user's week of activity (Jira changelogs, GitLab events,
calendar, RescueTime) to suggest Jira worklogs. One client — **puma** — uses
**GitHub**, not GitLab, so none of their development work currently produces
suggestions. The user wants GitHub to drive "the most/best possible" worklog
suggestions.

### Why this is not just "GitLab, but GitHub"

The GitLab integration scrapes Jira keys (`[A-Z]+-\d+`) out of commit messages,
branch names, and MR titles via the GitLab Events API, then suggests worklogs
against the matched issues. Porting that 1:1 would work **only if** puma's
commits/branches/PRs reliably carry Jira keys — which we cannot assume.

Two findings reshape the design:

1. **GitHub's REST API supports CORS.** `api.github.com` returns
   `Access-Control-Allow-Origin: *`, so the browser can call it **directly** —
   no CORS proxy, no hosted relay (unlike GitLab/RescueTime). Verified
   2026-06-23 against `/user` and `/users/{u}/events`.
2. **Jira already knows the GitHub↔issue links.** puma's Jira has the GitHub
   development integration connected (Development panel populated — confirmed by
   the user). Jira's `dev-status` API exposes, per issue, the linked commits /
   branches / PRs. This catches work even when individual commits are keyless,
   because the key only has to appear **once** (on the branch or PR) for Jira to
   attach the whole branch's commits to the issue.

These pull in opposite, complementary directions, so v1 uses **both**.

## Solution

A **hybrid** GitHub worklog source feeding the existing `mergeSuggestions`
pipeline, with two data sources, each used for what it is best at:

| Activity | dev-status (Jira→GitHub) | Events (GitHub→Jira) |
| --- | --- | --- |
| Your commits on a linked branch (keyless commits ok) | ✅ | ✅ if key in text |
| A PR you opened / merged | ✅ | ✅ |
| **Your review / comment on someone else's PR** | ❌ | ✅ |

- **dev-status** answers *"what code is mine on issues I own"* — robust to
  missing keys.
- **Events** answers *"where did I participate"* — robust to issues I don't
  own (reviews, drive-by comments), which dev-status cannot attribute to a
  commenter.

Together they approximate "everything you actually did." Overlap is handled for
free by the existing dedup-by-confidence merger (see §5) — we never sum across
sources, so there is no time inflation.

### 1. Source 1 — Jira dev-status (`devActivityService.ts`)

New service: `fetchDevActivitySuggestions(config, weekStart, weekEnd, currentUser, signal?)`.

Flow:
1. Reuse the JQL from `fetchJiraActivitySuggestions`
   (`assignee = currentUser() OR worklogAuthor = currentUser() AND updated`
   within the week) to get the week's candidate issues **including the numeric
   `id`** (Jira search already returns `id`; today's `JiraIssueWithChangelog`
   type just omits it — add it).
2. For each issue, a cheap summary probe:
   `GET /rest/dev-status/latest/issue/summary?issueId=<id>` → counts of
   `{branches, commits, pullrequests, reviews}`. Skip issues with no dev data.
3. For issues with data:
   `GET /rest/dev-status/latest/issue/detail?issueId=<id>&applicationType=GitHub&dataType=repository`
   (and `dataType=branch` / `pullrequest` as needed) → commits with
   `author`, `authorTimestamp`, `message`, `displayId`; PRs with `author`,
   `status`, `lastUpdate`, `name`.
4. Keep only items **authored by the current user** (see §6) whose timestamp
   falls in `[weekStart, weekEnd]`. Estimate time with the GitLab heuristics
   (≈1h/commit, capped 4h/day; 30m/PR action, capped 2h/day; 6h/day/issue
   overall cap). Emit `WorklogSuggestion { source: 'github' }`.

All calls go through the **existing Jira request path** (`fetchSearchPage` /
the Jira gateway), so they inherit the hosted-proxy-or-direct routing, auth
headers, and SSRF/host handling already built for Jira. No new server code.

> **Note — `applicationType`.** Cloud GitHub is `GitHub`; GitHub Enterprise is
> `githube`. v1 targets cloud (`GitHub`). The summary endpoint reports which
> application instances carry data, so detail calls can be issued only for the
> types actually present (avoids empty round-trips and supports future GHES).

### 2. Source 2 — GitHub Events (`githubService.ts`)

Mirrors `gitlabService.ts`. `fetchGithubSuggestions(githubToken, githubHost, weekStart, weekEnd, signal?)`:

- Resolve identity: `GET https://api.github.com/user` → `login`, `name`.
- Fetch the user's performed events:
  `GET /users/{login}/events?per_page=100` (paginate up to the 300-event / 90-day
  ceiling the API enforces).
- Handle event types:
  - `PushEvent` → keys from `payload.commits[].message` + the branch in
    `payload.ref`. ≈1h/commit, capped.
  - `PullRequestEvent` (opened/closed/merged) → keys from
    `payload.pull_request.title` + head ref. 30m/action.
  - `PullRequestReviewEvent`, `PullRequestReviewCommentEvent`,
    `IssueCommentEvent` (PR conversations; PRs are issues in GitHub) → keys from
    the PR title and the comment/review body. **15m each** — this is the
    "comments on others' PRs" path. Caps mirror GitLab's review handling.
- Client-side date filter to `[weekStart, weekEnd]` (events feed is reverse-chron;
  stop paging once older than the window).
- Auth: `Authorization: Bearer <githubToken>`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`.
- Base URL: `https://api.github.com` directly when `githubHost` is empty
  (github.com). `githubHost` is **seeded in config now but not surfaced in the
  UI** — future GHES support would set base `https://<host>/api/v3` and, because
  GHES CORS is not guaranteed, route through the user CORS proxy like GitLab.
  `buildGithubBaseUrl(githubHost, corsProxy)` is written to accommodate this so
  GHES is later a config/UI change, not a rewrite.

Reuse the boundary-safe `JIRA_KEY_RE` and `extractJiraKeys` logic (currently in
`gitlabService.ts`) — extract to a shared `jiraKeys.ts` util so both services
share one implementation rather than duplicating the regex.

### 3. Config (`useConfigStore.ts`)

- Add `githubToken: string` (default `''`, trimmed on normalize).
- Add `githubHost: string` (default `''`, normalized like `gitlabHost`; **not**
  shown in the UI in v1 — reserved for GHES).
- Bump the storage schema version and add a no-op migration entry (new optional
  fields default to `''`, so no data transform is needed — consistent with how
  `gitlabHost` was introduced).

### 4. Settings UI (`IntegrationsSection.tsx` + `SettingsForm.tsx` + `useSettingsFormStore.ts`)

- New **GitHub** service card mirroring the GitLab card: a token (`password`)
  field, status badge, and a **"Test GitHub"** button. Help text: classic PAT
  with `repo` + `read:user` scope, or a fine-grained PAT with read access to the
  relevant repos' contents/PRs.
- `canTestGithub = !!formData.githubToken.trim()`.
- `testGithub()` action:
  1. `GET /user` to validate the token and read `login` (HTTP 401 → "token
     rejected", 403 → "access denied / scope", else generic). Reuse a
     `describeGithubConnectionError` mirroring the GitLab helper.
  2. **Coverage preview** (the design's investigation built into the product):
     fetch the week's events + run dev-status summaries over the week's issues,
     then report, e.g.:
     `Connected as @you — 38 events this week, 24 referenced Jira keys
     (e.g. PUMA-412); 9 of 14 of your issues have GitHub dev-panel data.`
     This tells any user, with real data, whether the hybrid will produce value.

### 5. Dashboard wiring + merge (`useDashboardDataFetcher.ts`, `suggestionMerger.ts`)

- In the fetcher's `Promise.all`, add:
  - `fetchGithubSuggestions(githubToken, githubHost, weekStart, weekEnd, signal)`
    when `githubToken` is set (no proxy arg — direct).
  - `fetchDevActivitySuggestions(config, weekStart, weekEnd, currentUser, signal)`
    when `jiraHost`/`apiToken` are set (rides Jira auth).
  - Each wrapped in the existing `.catch(setError)/.finally(setLoading)` pattern;
    add a `github` loading/error channel alongside `gitlab`.
- `mergeSuggestions`: add the GitHub/dev-status suggestions into `allSuggestions`
  alongside `gitlabSuggestions`. The existing dedup — keyed `${date}::${issueKey}`,
  keeping the **highest-confidence** suggestion and dropping already-logged
  issues — collapses overlap between the two GitHub sources (and with Jira/GitLab)
  automatically. **No summing across sources**, so no double-counting.

### 6. Author matching

dev-status commits carry an author *name/avatar*, not a guaranteed GitHub login.
Because the user is providing a GitHub token, we resolve their GitHub identity
once (`/user` → `login`, `name`) and match dev-status authorship against it
(login or display name), falling back to the Jira account display name (from
`/myself`/config) when GitHub identity is unavailable. Events from
`/users/{login}/events` are inherently the user's own actions, so reviews and
comments need no extra author filtering.

### 7. Error handling

- GitHub: 401 → invalid/expired token; 403 → scope/SSO/rate-limit (surface
  `X-RateLimit-Remaining`); network/`TypeError` → connection copy via
  `describeGithubConnectionError`. `AbortError` and `ServiceError` propagate
  unchanged (mirrors GitLab).
- dev-status: a failure on one issue must not sink the batch — per-issue
  `try/catch`, skip-and-continue, so a single unlinked or permission-denied issue
  degrades gracefully. dev-status is **best-effort enrichment**; an empty result
  is a valid outcome (integration not connected for that project), never an error
  shown to the user.
- Both sources are independent: if GitHub Events fails, dev-status suggestions
  still render, and vice-versa.

### 8. Testing

- `githubService.test.ts` (mirror `gitlabService.test.ts`): key extraction
  (incl. shared `jiraKeys.ts`), event-type handling incl.
  review/comment-on-others'-PR, date-window paging/stop, error propagation
  (401/403/abort/network), `Authorization: Bearer` shape.
- `devActivityService.test.ts`: summary-then-detail flow, per-issue isolation on
  failure, author/date filtering, dev-status → suggestion mapping, empty-when-not-
  connected.
- `suggestionMerger` test: GitHub + dev-status overlap dedups by confidence with
  no time inflation; already-logged issues excluded.
- `useSettingsFormStore` test: `testGithub` success (coverage copy), 401/403
  messages, key never echoed.

## Scope (YAGNI)

**In:** the two sources, shared `jiraKeys.ts`, GitHub settings card + test +
coverage preview, config fields, dashboard/merge wiring, tests.

**Out (now):** GHES host UI (field seeded, not shown); Bitbucket UI (dev-status
returns it for free but we won't expose it); exact per-comment durations beyond
the heuristic; any hosted server endpoint (none needed — github.com is direct,
dev-status rides the existing Jira proxy).

## Key dependencies / risks

- **dev-status requires the GitHub↔Jira dev integration** (confirmed present for
  puma). For users without it, Source 1 yields nothing and the feature degrades
  to Source 2 (Events) only — still useful. The coverage preview makes this
  visible per user.
- **GitHub Events API ceiling:** ~300 events / 90 days, ~30–60s cache. Ample for
  a single user's one-week window; the coverage preview's event count doubles as
  a "did we hit the ceiling" signal.
- **dev-status is an unofficial API** (Atlassian may change it between versions).
  Isolated in `devActivityService.ts` behind a typed adapter so a contract change
  is contained to one file.

## Files touched

New: `frontend/services/githubService.ts`,
`frontend/services/devActivityService.ts`, `frontend/services/jiraKeys.ts`,
their `__tests__`.

Modified: `types/Suggestion.ts` (**add `'github'` to the `source` union** —
currently `jira-activity | gitlab | calendar | rescuetime | favorite | template
| previous-week`), `frontend/stores/useConfigStore.ts`,
`frontend/stores/useSettingsFormStore.ts`,
`frontend/react/components/settings/sections/IntegrationsSection.tsx`,
`frontend/react/components/settings/SettingsForm.tsx`,
`frontend/react/hooks/useDashboardDataFetcher.ts`,
`frontend/services/suggestionMerger.ts`,
`frontend/services/gitlabService.ts` (extract shared `jiraKeys.ts`).
