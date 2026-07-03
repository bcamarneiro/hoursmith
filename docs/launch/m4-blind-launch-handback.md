# M4 — Blind launch handback

> The engineering work for the M4 (Blind launch) milestone that can be done
> **in code** is shipped as the PRs below. What remains is **external
> operations** that only the account owner can execute (Polar KYC, production
> secrets, the paywall flip, external monitoring, Supabase delegation). This
> doc is the durable handoff for those.
>
> Anchor: M4 = "soft, unannounced launch" — the product is live at
> `hoursmith.io` with the purchase gate **closed** (allowlist = owner email,
> server-enforced via Edge Config). Blind launch = flip the gate open to a
> small, hand-picked cohort with billing actually working end-to-end.

## 1. Code shipped for M4 (PR merge order)

These are stacked to avoid conflicts on the shared completeness/on-time
functions. **Merge bottom-up**; GitHub retargets each to `main` as the one
below it lands.

| PR | Ticket(s) | What |
|----|-----------|------|
| #119 `feat/team-completeness-trust-fixes` | ADA-477, ADA-488 | Prorated mid-week gap signal (kills "everyone red on Monday") + roster fixes |
| #121 `feat/expected-hours-profiles` | ADA-392, ADA-386 | Per-user expected-hours config + completeness-vs-expected target |
| #123 `feat/on-time-tracking` | ADA-387 | Configurable weekly deadline + on-time/late/incomplete/pending status |
| #124 `feat/rag-dashboard` | ADA-388 | Per-person × per-week RAG grid + on-time history + drill-through |
| #120 `feat/security-trust-hub` | ADA-305 | `/security` trust hub page (M3) |
| #122 `feat/onboarding-first-run` | ADA-484, ADA-470, ADA-314 | First-run onboarding + demo-first CTAs + empty-state previews |

Each PR is green on the full unit suite (1065 tests) + typecheck + biome, and
carries its own test coverage. Review notes are in each PR body.

## 2. External-only go-live checklist (owner actions)

None of these can be done from the codebase — they need account access,
identity verification, or production secrets. Ordered by dependency.

- [ ] **ADA-338 — Polar production activation.** Complete Polar merchant-of-record
      KYC / payout onboarding. Blocks every paid flow below. (Sandbox org +
      products already exist per the staging config.)
- [ ] **Create the production €19 product** in Polar and record its product ID.
- [ ] **ADA-337 — Comp / free-forever codes.** Create the discount/comp codes in
      Polar for pilot users who shouldn't be charged.
- [ ] **Set production secrets** (see §3): `POLAR_ACCESS_TOKEN`,
      `POLAR_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_POSTHOG_KEY`.
      Handle via the platform secret store — never commit or paste them.
- [ ] **ADA-287 — Dashboard / alert configs.** Wire the operational alerts
      (Vercel cost, failed-payment webhook, uptime) — see §4.
- [ ] **ADA-276 — Post-launch monitoring.** Sub-count, proxy error rate, cost.
- [ ] **Supabase project delegation** (bus-factor): add a second admin to the
      Supabase project, or document the recovery procedure. If the owner
      account locks, the database is otherwise unrecoverable.
- [ ] **ADA-353 — Flip the purchase gate.** This is the actual "launch" switch:
      change the Edge Config allowlist from `owner-email-only` to the pilot
      cohort (or open). Server-enforced, so this is the single point of control.

## 3. Environment variables (source · scope · rotation)

> Fill in the production values from the platform secret store — this table is
> the map, not the secrets. Rotate by issuing a new value at the source, then
> updating the platform env and redeploying.

| Var | Source | Scope | Notes |
|-----|--------|-------|-------|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project → API | Server (Edge functions) | Full DB access — never expose to the client. Rotate in Supabase, update platform env. |
| `POLAR_ACCESS_TOKEN` | Polar → Settings → API | Server | Billing API. Rotate in Polar; revoke the old token after cutover. |
| `POLAR_WEBHOOK_SECRET` | Polar → Webhooks | Server | Verifies inbound webhook signatures. |
| `VITE_POSTHOG_KEY` | PostHog (EU) → Project | Client (build-time) | Empty = analytics off (cookieless EU). Set to activate. |
| `LEAD_TIER_ENABLED` | Build flag | Build | Hides the Lead tier when false. |
| Edge Config allowlist | Platform Edge Config | Server | The purchase gate. Owner-email-only until ADA-353. |

## 4. Monitoring & runbook follow-ups (ADA-310 / ADA-276 / ADA-287)

These need the live provider dashboards to author accurately, so they're owner
tasks rather than repo docs authored blind:

- **External uptime monitor** (BetterStack free tier or Cronitor): probe the
  homepage (expect `200`) and `/api/proxy` (expect `401` for anon). Alert to
  email + SMS. Send a test alert to confirm delivery.
- **Billing-webhook runbook** (`docs/runbooks/billing-webhook.md`): replay
  procedure + subscription-reconciliation SQL, authored against the **actual**
  Polar webhook payloads + Supabase `subscriptions` schema once production is
  live. Skeleton intent: on 5xx, replay from Polar's webhook log; reconcile by
  comparing Polar's active-subscription list against the Supabase table.
- **Supabase recovery runbook** (`docs/runbooks/supabase-recovery.md`): the
  delegation + recovery procedure from the checklist above.

## 5. Known code follow-ups (not launch-blocking)

Flagged during the M4 build; tracked in Linear, safe to ship after the stack
merges:

- **ADA-386 (monthly)** — the monthly-view completeness + monthly deadline
  ("3rd working day of next month"); the weekly path shipped in #121/#123.
- **ADA-388 sort/filter** — the RAG grid pre-sorts worst-first; wiring the
  panel's existing "only attention" filter to the grid is a small follow-up.
- **ADA-484 items 1/2/4** — Settings progressive disclosure + inline token
  walkthrough + CORS error copy (couples to the Settings redesign).
- **ADA-274 (M3)** — the paid-lifecycle e2e (checkout → active → cancel → 403).
  Needs a runnable Playwright env with Supabase/Polar/proxy mocked via
  `page.route`, or a staging run against the Polar sandbox. Not authored here
  because it can't be executed (and therefore verified) from this environment.
- **`fetchTeamWorklogs`** in `frontend/services/teamService.ts` still uses the
  fixed 8h/day target and doesn't read the expected-hours config — the Reports
  path uses `buildTeamSummaries` (which does). Align the two producers if that
  legacy path is still reachable.
