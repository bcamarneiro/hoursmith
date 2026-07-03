# Runbook — Supabase project recovery & delegation

> **Scope.** Bus-factor mitigation for the Supabase project that backs Hoursmith
> Premium (auth + the `subscriptions`/`profiles` billing tables). Today there is
> a single owner; if that account is lost, the database is unrecoverable. This
> runbook covers adding a delegate, backups, key rotation, and recovery.
> Account-console paths are marked _verify_ — confirm on first use.

## What lives here (and what doesn't)

The Supabase project stores **only** auth users + two billing tables — **no
Jira data ever** (Jira credentials travel per-request through the proxy and are
never persisted). Tables (`public` schema):

- `profiles` — one row per auth user (auto-created by the `on_auth_user_created`
  trigger). `id` FK → `auth.users`.
- `subscriptions` — tier/status per user. Written **only** by the checkout
  function and the Polar webhook, via the service-role key (RLS blocks all
  user writes; users read only their own row).
- `billing_event_log` — webhook idempotency keys.
- Plus `audit_log`, `waitlist`, `rate_limit_counters` (see `premium/supabase/migrations/`).

Production project ref: _verify in the Supabase dashboard_. Staging branch ref:
`navbjcdtwywwgrgqkyob` (separate DB).

## 1. Add a delegate (do this first)

A second human with admin on the project is the whole point.

1. _verify: Supabase → Organization → Team / Members → **Invite member**._
2. Grant the delegate **Owner** or **Administrator** on the org that holds the
   production project.
3. Confirm they can reach Project → Settings → Database and Project → Auth.
4. If genuinely no second person exists, at minimum ensure the recovery email on
   the owner account is a mailbox a second trusted party can reach, and store
   the recovery codes offline (§4).

## 2. Backups

- **Managed PITR / daily backups**: _verify: Supabase → Project → Database →
  Backups._ Confirm the retention window meets your RPO; on the free/entry tier
  daily backups may be limited — consider a scheduled logical dump (below).
- **Logical dump (portable, provider-independent)** — run periodically and store
  off-Supabase (the data is tiny — no Jira data, just auth + billing):

  ```bash
  # Needs the DB connection string (Project → Settings → Database → Connection).
  pg_dump "$SUPABASE_DB_URL" \
    --schema=public --no-owner --no-privileges \
    -f "hoursmith-backup-$(date +%F).sql"
  ```

  The `public` tables above are enough to reconstruct entitlement state; the
  `auth` schema is Supabase-managed and restored from their backups.

## 3. Key rotation

Two keys matter:

- **`anon` key** — public-by-design (RLS-gated), shipped in the client bundle.
  Rotating it means rebuilding/redeploying the frontend with the new value
  (`VITE_SUPABASE_ANON_KEY`).
- **`service_role` key** — full DB access, **server-only** (checkout fn + Polar
  webhook). Never in the client. Rotate on suspected exposure:
  1. _verify: Supabase → Project → Settings → API → Roll `service_role`._
  2. Update the server env everywhere it's set (production deploy env + the
     staging `SUPABASE_STAGING_SERVICE_ROLE_KEY` CI secret) and redeploy.
  3. Confirm the Polar webhook + checkout still succeed (watch for
     `server_misconfigured` / `upsert_failed` in the webhook logs).

Handle these values only through the platform secret stores — never paste them
into chat, commits, or logs.

## 4. Recovery — owner account locked/lost

In priority order:

1. **Delegate takes over.** If §1 is done, the delegate has full access —
   nothing else to do. _This is why §1 is the mitigation._
2. **Account recovery.** Use the Supabase account recovery flow on the owner
   email; if MFA is the blocker, use the **stored offline recovery codes**
   (generate + store these now, before an incident).
3. **Supabase support.** For a paid project, open a support request for
   ownership recovery with proof of billing ownership. _verify current process._
4. **Rebuild from backup (worst case).** Provision a new project, run
   `premium/supabase/migrations/` in order, restore the latest logical dump
   (§2), re-point the deployment env (URL + keys), re-create the Polar webhook
   endpoint, and reconcile subscriptions against Polar (see
   `billing-webhook.md` → Reconciliation SQL).

## 5. Verify recovery worked

- Sign-in works and `/account` renders a real subscription state.
- A test Polar (sandbox) event lands and writes a row — watch the webhook log
  for `outcome: "ok"`.
- The hosted proxy returns 200 for an entitled user and 403
  (`subscription_required`) for a free one.
