# Tempo as a worklog backend (reads + writes)

**Date:** 2026-06-24 · **Status:** approved

## Problem

On Jira instances where time tracking is managed by **Tempo Timesheets**, the
worklogs returned by Jira's REST API are authored by the **Tempo app account**
(`accountType: "app"`, `displayName: "Timesheets by Tempo - Jira Time
Tracking"`), which carries **no `emailAddress`**. Hoursmith's current-user views
identify "my" worklogs by email:

- `frontend/services/worklogService.ts:96` — `if (wl.author?.emailAddress?.toLowerCase() !== email) continue;`
- `frontend/services/monthWorklogService.ts:177-178` — the `matchesAuthor` filter.

Both compare against `config.email`. Tempo-app authors have no email, so **every
worklog is dropped** and the user sees an empty timesheet even though the data
exists in Jira. The JQL clause `worklogAuthor = currentUser()` (worklogService
line 59) compounds this: Jira attributes worklog authorship to the Tempo app, so
the clause can return zero issues. (Reproduced 2026-06-24 against
`pumaglobal.atlassian.net`: dropping `worklogAuthor` and querying by
`project in (...)` returns worklogs; the per-user app view shows none.)

The fix is to read and write worklogs through **Tempo's own API**, which carries
the real worker's `accountId`, when the instance is Tempo-managed.

## Scope

Reads **and** writes, delivered together ("all at once"), Tempo **Cloud** only
(`https://api.tempo.io/4/`). Tempo Server/DC (a different API on the Jira host)
is explicitly out of scope.

## Decisions (from brainstorming)

1. **Source model:** auto-detect Tempo usage; when Tempo is the active source,
   **both** reads and writes go through Tempo (they are coupled — a worklog
   POSTed to Jira would be authored by the human and become invisible to the
   Tempo-app-author filter, or double-counted once Tempo imports it).
2. **Detection:** passive author-signal (worklogs authored by an app account)
   surfaces a "Connect Tempo" prompt; the entered token is validated with a real
   Tempo call. A manual `tempoMode` override covers the empty-worklog edge case.
3. **Tier gating:** mirror RescueTime — hosted Tempo relay (zero proxy config)
   is **Premium**; free-tier users use their own self-hosted CORS proxy;
   `direct` mode fails fast.
4. **Architecture:** gateway + service + mapper + a thin source resolver
   (approach A). Existing Jira paths remain the untouched default.

## API assumptions

Deployment is **confirmed Tempo Cloud** (the Jira instance is Cloud, verified
with the user 2026-06-24). The endpoint request/response *shapes* below should
still be verified against the live Tempo Cloud v4 docs during planning.

- Base URL `https://api.tempo.io/4/`, auth `Authorization: Bearer <Tempo API token>`
  (token generated in Tempo → Settings → API integration).
- `GET /4/worklogs/user/{accountId}?from=YYYY-MM-DD&to=YYYY-MM-DD` — current-user
  reads, paginated via `metadata.next`.
- `GET /4/worklogs?from&to` — non-user-scoped reads (team path).
- `POST /4/worklogs` — body `{ authorAccountId, issueId (numeric), timeSpentSeconds,
  startDate, startTime, description }`.
- `PUT /4/worklogs/{tempoWorklogId}`, `DELETE /4/worklogs/{tempoWorklogId}`,
  `GET /4/worklogs/{tempoWorklogId}`.
- Worklog payload exposes `tempoWorklogId`, `jiraWorklogId`, `issue.id` (+ `self`,
  **no key/summary**), `timeSpentSeconds`, `startDate`, `startTime`, `description`,
  `author.accountId`, `createdAt`, `updatedAt`.

## Architecture (approach A)

### New files

- `frontend/services/tempoGateway.ts` — 3-mode URL/header builder for
  `api.tempo.io`, a near-copy of `rescueTimeGateway.ts`.
- `frontend/services/tempoWorklogService.ts` — Tempo reads
  (`fetchWeekWorklogsTempo`, `fetchMonthWorklogsTempo`, team read), returning the
  **same** `WorklogEntry` / `EnrichedJiraWorklog[]` shapes the Jira services
  return.
- `frontend/services/tempoWriteService.ts` — Tempo create / update / delete /
  getWorklog.
- `frontend/services/tempoMapper.ts` — **pure** mapping Tempo worklog →
  `EnrichedJiraWorklog`, plus the Jira issue-metadata enrichment helper.
- `frontend/services/worklogSource.ts` — `getWorklogSource(config, signals) →
  'jira' | 'tempo'` resolver + a `useWorklogSource()` convenience.
- `api/tempo/` and `premium/api/tempo/` — the hosted Premium relay endpoint,
  mirroring `api/rescuetime`. **Must forward `GET/POST/PUT/DELETE` + bodies**
  (RescueTime's relay is read-only; Tempo's is not).

### Changed files

- `frontend/stores/useConfigStore.ts` — add `tempoApiToken: string` and
  `tempoMode: 'auto' | 'jira' | 'tempo'` (default `'auto'`) to `Config`, plus
  normalization + a version migration so existing persisted configs gain the
  fields.
- `frontend/services/worklogService.ts`, `monthWorklogService.ts` — unchanged as
  the Jira impl; callers route through the resolver.
- `frontend/react/hooks/useWorklogOperations.ts` — branch create/update/delete to
  `tempoWriteService` when the source is `tempo`.
- Read hooks (`useMonthWorklogs`, `useDashboardDataFetcher`, `useCopyPreviousWeek`,
  `useReportsTrendData`, `ReportsPage`) — call through the resolver instead of
  importing the Jira service directly.
- Settings UI — Tempo token field, "My Jira uses Tempo" (`tempoMode`) control,
  and a "Test connection" button.

### Boundaries

Tempo logic is fully contained in the `tempo*` services + the relay. The
resolver is the only new branch point in existing hooks. Downstream hooks and
components are unchanged — they still receive `EnrichedJiraWorklog` /
`WorklogEntry`; only the source of truth swaps.

## Detection & connect/validate UX

**Passive detection.** The Jira read services already fetch `author`. Add a check:
if returned worklogs include any authored by an app account
(`author.accountType === 'app'` or `displayName` matching `/tempo/i`) while the
current-user filter drops them to ~zero, set a transient `tempoSuspected` signal.

**Surfacing.** When `tempoSuspected` and no Tempo token is configured, show a
non-blocking banner: *"This Jira logs time through Tempo. Connect Tempo to see
and edit your worklogs."* → opens the Settings → Tempo section.

**Manual override (`tempoMode`).**
- `auto` (default) — Tempo used when a token is present **and** Tempo is
  detected/suspected; otherwise Jira.
- `tempo` — force Tempo (covers the empty-worklog case where passive detection
  cannot fire).
- `jira` — force native Jira (escape hatch if detection misfires).

**Connect + validate.** The Tempo token field has a "Test connection" button that
calls a cheap authenticated Tempo endpoint (e.g. `GET /4/worklogs?limit=1`)
through the active gateway and reports a typed success/failure. The resolver only
returns `'tempo'` once a token exists; an unvalidated/empty token never silently
swaps the source.

**Resolver truth table.**

| tempoMode | token present | detected | → source |
|-----------|--------------|----------|----------|
| `auto`    | no           | –        | jira |
| `auto`    | yes          | yes      | **tempo** |
| `auto`    | yes          | no       | jira (token idle) |
| `tempo`   | yes          | –        | **tempo** |
| `tempo`   | no           | –        | jira + "token required" notice |
| `jira`    | –            | –        | jira |

## Read data flow

### Current-user path

1. **Resolve `accountId`.** Tempo filters by `accountId`, not email. Call Jira
   `GET /rest/api/2/myself` once (through the existing Jira gateway), cache the
   `accountId` (in-memory + persisted alongside config). This is the email→
   accountId bridge the app currently lacks.
2. **Fetch from Tempo.** `GET /4/worklogs/user/{accountId}?from&to` through
   `tempoGateway`, paginating on `metadata.next`. No app-author filtering needed
   — Tempo carries the real worker.
3. **Enrich issue metadata from Jira.** Tempo returns issue `id` only. Collect the
   unique issue IDs and batch-fetch their fields from Jira via JQL
   `issue in (id1,id2,…)` with `fields=key,summary,issuetype,parent,project,status`.
   **Chunk** the id list (~100/query) to stay under JQL/URL limits. Build an
   `id → issueFields` map.
4. **Map → `EnrichedJiraWorklog`** in `tempoMapper.ts`:
   - `id` ← `tempoWorklogId` (string); keep `jiraWorklogId` for cross-reference.
   - **Day** ← Tempo `startDate` directly (it is already the worker's wall-clock
     day — no instant reconstruction, avoiding midnight-boundary TZ bugs).
   - `started` ← `${startDate}T${startTime ?? '00:00:00'}` so `worklogMonth()` and
     any `new Date(started)` consumers bucket correctly.
   - `timeSpentSeconds`, `comment` ← `description`.
   - `author` ← synthesize `{ accountId, emailAddress: config.email }` so
     downstream email grouping (e.g. `teamReports`) still works.
   - `issue` ← from the Step-3 map; **missing issues render with a placeholder**
     (`"Unknown issue · <id>"`), never dropped (avoids undercount; cf. ADA-456a).
   - **Backdate flagging is off for Tempo v1.** `classifyWorklog`'s backdate
     detection is Jira-worklog-specific (comment markers, created>started cross-
     month). Tempo's day comes straight from `startDate`, so backdate detection
     does not map cleanly; deriving it from Tempo `createdAt` vs `startDate` is a
     deliberate future enhancement, not part of v1.

### Team / all-users path

Reports/team aggregation (`teamReports.ts`, `monthlyReport`) and the
`currentUserOnly=false` month path read **everyone's** worklogs. For Tempo:
- Use the non-user-scoped `GET /4/worklogs?from&to`.
- Map each worklog's `author.accountId` → a human (display name/email) via a Jira
  user lookup (`GET /rest/api/3/user?accountId=…`, batched/cached). `teamReports`
  already prefers `accountId → email → synthetic` grouping
  (`teamReports.ts:54`), so accountId-keyed grouping fits.
- Same issue-enrichment + mapping as the current-user path.

### Caching

Reuse the existing `['monthWorklogs', year, month, …]` query keys so
`patchMonthCaches` keeps working identically. The week path returns
`WorklogEntry[]` exactly as today.

## Write data flow

All writes branch in `useWorklogOperations` on `getWorklogSource(config)`. When
the source is `tempo`, they call `tempoWriteService`; otherwise the current Jira
path is untouched.

- **Create** (`POST /4/worklogs`): the create path already GETs the issue to
  validate it — read **`issue.id`** from that same response (no extra key→id
  call). Body `{ authorAccountId, issueId, timeSpentSeconds:
  parseTimeSpentToSeconds(timeSpent), startDate, startTime, description }`. The
  response `tempoWorklogId` is mapped (enriched with the just-fetched issue) to an
  `EnrichedJiraWorklog` with `id = tempoWorklogId`, then `patchMonthCaches`
  applies unchanged.
- **Update** (`PUT /4/worklogs/{tempoWorklogId}`): the worklog `id` is already the
  `tempoWorklogId` (from the mapper), so edits address the right record.
- **Delete** (`DELETE /4/worklogs/{tempoWorklogId}`): same id, then patch caches.
- **getWorklog** (edit-form preserve step): `GET /4/worklogs/{tempoWorklogId}` →
  map `description`→comment, `timeSpentSeconds`→`formatJiraTimeSpent`, compose
  `started`.
- **createMultiple:** create, looped (unchanged control flow).

Existing helpers `parseTimeSpentToSeconds` and `formatJiraTimeSpent`
(`frontend/react/utils/timeSpent.ts`, `format.ts`) handle the string↔seconds
conversion Tempo requires.

**Cache settling:** keep `patchMonthCaches` for Tempo too (do **not** add a
refetch branch). Tempo is read-after-write consistent, so a refetch would also be
safe, but patching gives instant optimistic UI and reuses pure helpers that
already operate on `EnrichedJiraWorklog` — zero new code, and it avoids a second
behavioral axis ("where the write goes" × "how the cache settles") in an already-
branchy hook. The mapper guaranteeing a parseable `started` is what makes this
work.

**Permission gates** (`canAddWorklogs/canEditWorklogs/canDeleteWorklogs`) still
gate the UI regardless of source.

## Gateway & premium

`tempoGateway.ts` — three modes mirroring `rescueTimeGateway.ts`:
- `hosted` (Premium): `${origin}/api/tempo`, auth `Bearer <supabaseJwt>`; the
  Tempo token travels in `X-Tempo-Token` and is attached to the upstream
  `Authorization` **server-side** (never in a browser-built URL).
- `self-hosted` (free): `${userProxy}/https://api.tempo.io/4/…` with
  `Authorization: Bearer <tempoToken>`.
- `direct`: would CORS-fail → callers check mode first and fail fast with
  actionable copy.

The gateway + relay live behind the same entitlement plumbing RescueTime uses;
`scripts/check-premium-boundary.cjs` must pass.

## Error handling

Reuse `serviceErrors.ts` / `fromHttpResponse`:
- **401** bad/expired Tempo token → "Reconnect Tempo" CTA.
- **403** token lacks scope.
- **404** worklog/issue gone.
- **5xx / network** retryable.
- A failed **issue-enrichment** chunk does **not** fail the whole read — affected
  worklogs render with the "Unknown issue" placeholder.
- A failed **Tempo worklogs** fetch **does** fail the read (no silent undercount,
  matching ADA-456a).

## Testing

- **Unit:** `tempoMapper` (id-only issue enrichment, missing-issue placeholder,
  `startDate`→day, `started` synthesis); `tempoGateway` (3 modes, token-in-header-
  never-in-URL); `worklogSource` resolver truth table; `parseTimeSpentToSeconds`
  round-trips.
- **Service:** `tempoWorklogService` week/month with mocked Tempo + Jira-
  enrichment responses, pagination, **the regression that started this** (an app-
  account-authored worklog now appears via Tempo); team-read path with multi-
  author mapping.
- **Write:** create/update/delete against mocked Tempo (issueId resolution,
  tempoWorklogId addressing, cache patch).
- **Relay:** `api/tempo` + `premium/api/tempo` unit tests mirroring
  `csp-report` / `subscription` / `rescueTimeForward` (auth, method forwarding,
  error mapping).
- **E2E:** extend `e2e/timesheet.spec.ts` with a Tempo-mode fixture.

## Out of scope

- Tempo Server/DC.
- OAuth 2.0 for Tempo (API token only in v1).
- Tempo-specific fields beyond worklog basics (billable seconds, accounts,
  approvals).
- Backdate detection for Tempo worklogs (future enhancement).
