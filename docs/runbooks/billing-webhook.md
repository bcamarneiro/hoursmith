# Runbook — billing webhook (Polar → Supabase)

> **Scope.** What to do when premium purchases aren't activating, a cancel
> didn't revoke access, or the Polar webhook is returning non-2xx. Authored from
> the handler (`premium/api/polar/webhook.ts`) and schema
> (`premium/supabase/migrations/20260516000001_init_paywall.sql`,
> `…_billing_event_log.sql`). Production dashboard paths are marked _verify_ —
> confirm them on first use.

## How it works (the 30-second model)

- Polar POSTs subscription lifecycle events to **`POST /api/polar/webhook`**
  (edge fn, region `fra1`).
- The handler: verifies the `webhook-signature` against `POLAR_WEBHOOK_SECRET`
  → dedups on the `webhook-id` header (via `billing_event_log`) → resolves our
  `user_id` → upserts `public.subscriptions` (keyed on `user_id`).
- **Only `subscription.revoked` downgrades a user to `free`.** A
  `subscription.canceled` with `cancel_at_period_end` keeps `status:'active'`
  until the period ends, when Polar fires `revoked`. This is intended.
- Upserts are idempotent (keyed on `user_id`; deliveries deduped on
  `webhook-id`), so **replaying an event is always safe**.

### The `subscriptions` row

| column | notes |
|---|---|
| `user_id` | PK, FK → `profiles.id`. The Supabase auth user. |
| `stripe_customer_id` | Polar customer id (column name is legacy Stripe). `not null`, unique. |
| `stripe_subscription_id` | Polar subscription id. Unique when present. |
| `tier` | `free` \| `premium` (DB CHECK). |
| `status` | `active`/`past_due`/`canceled`/`incomplete`/`trialing`/`unpaid` (DB CHECK). |
| `current_period_end` | `timestamptz`, null after revoke. |
| `updated_at` | auto (trigger); also the out-of-order guard. |

Entitlement (hosted proxy access) = `tier = 'premium' AND status IN
('active','trialing','past_due')` — `past_due` stays entitled through Polar's
dunning grace, `revoked` is the real cutoff.

## First triage — read the logs

Every delivery logs one structured line (`svc: "hoursmith-polar-webhook"`) with
an **`outcome`**. Find it in the Vercel function logs (_verify: Vercel →
Project → Logs, filter `hoursmith-polar-webhook`). The outcome tells you the
story:

| `outcome` | HTTP | Meaning → action |
|---|---|---|
| `ok` | 200 | Processed. `resulting_tier`/`resulting_status` show the write. |
| `ignored_duplicate_event` | 200 | Replay; already processed. Benign. |
| `ignored_stale_event` | 200 | Out-of-order; a newer state already applied. Benign. |
| `ignored_unknown_event` | 200 | Not a `subscription.*` event. Benign. |
| `ignored_wrong_environment` | 200 | **Prod deploy talking to Polar sandbox.** See §Env guard. |
| `ignored_unknown_product` | 200 | Paid product not in `POLAR_PRODUCT_HOSTED/LEAD`. See §Product guard. |
| `missing_user_id` | 200 | Couldn't map the Polar customer to a user. See §User mapping. |
| `missing_signature` / `invalid_signature` | 400 | Secret mismatch. See §Signature. |
| `invalid_payload` | 400 | Unparseable body or missing `webhook-id`. |
| `server_misconfigured` | 500 | Missing `POLAR_WEBHOOK_SECRET` or Supabase admin env. |
| `upsert_failed` | 500 | DB write failed. Polar will retry (idempotent). |

## Symptom → cause → fix

### "Customer paid but is still on Free / proxy 403"

Walk these in order:

1. **Env guard (most common at go-live).** In a `production` deployment,
   `POLAR_SERVER` must be **explicitly `production`** — unset resolves to
   sandbox and every event is dropped as `ignored_wrong_environment`. Check the
   env; set `POLAR_SERVER=production` and redeploy. Then replay the deliveries.
2. **Product guard.** A non-revoke event only grants premium for a product in
   `POLAR_PRODUCT_HOSTED` / `POLAR_PRODUCT_LEAD`. If those env vars don't match
   the **live** product ids, you'll see `ignored_unknown_product`. Fix the env,
   redeploy, replay.
3. **User mapping.** `missing_user_id` means Polar didn't echo our user id.
   Checkout sets `customer_external_id = userId`; the handler also falls back to
   `metadata.user_id` and a lookup by `customer_id`. If checkout isn't setting
   external id, new customers won't map. Confirm the checkout function, then
   manually reconcile the affected row (below).
4. **Never delivered.** If there's no log line at all, check Polar's webhook
   delivery list (_verify: Polar → Settings → Webhooks → the endpoint → recent
   deliveries) for 4xx/5xx, then replay.

### "Cancelled but still has access"

Expected until the period ends — only `subscription.revoked` downgrades. If the
period end has passed and they're still premium, the `revoked` event was missed:
replay it from Polar, or manually revoke (below).

### "Webhook is 5xx-ing"

- `server_misconfigured` → `POLAR_WEBHOOK_SECRET` or the Supabase service-role
  env is missing on the deployment. Set it, redeploy.
- `upsert_failed` → Supabase write is failing (outage, RLS, constraint). Check
  Supabase status; the event will be retried automatically once healthy.
- `invalid_signature` → the deployment's `POLAR_WEBHOOK_SECRET` doesn't match
  the secret Polar signs with. Rotate/realign them (they must be identical).

## Replaying events

Idempotent + deduped, so replay freely. Polar → Webhooks → the endpoint →
select the failed/needed deliveries → **Resend** (_verify exact label). An
already-processed `webhook-id` returns `ignored_duplicate_event` (200) — safe.

## Reconciliation SQL

Run in the Supabase SQL editor (service-role). Read-only queries first.

```sql
-- Snapshot of the paid base.
select tier, status, count(*) from public.subscriptions group by 1, 2 order by 1, 2;

-- Stuck in 'incomplete' > 1h: checkout created the row but no activating event
-- ever landed (webhook drop, env/product guard, or abandoned checkout).
select s.user_id, p.email, s.status, s.updated_at
from public.subscriptions s join public.profiles p on p.id = s.user_id
where s.status = 'incomplete' and s.updated_at < now() - interval '1 hour'
order by s.updated_at;

-- Premium past period end but not revoked → a missed `subscription.revoked`.
select s.user_id, p.email, s.current_period_end
from public.subscriptions s join public.profiles p on p.id = s.user_id
where s.tier = 'premium' and s.current_period_end is not null
  and s.current_period_end < now();

-- Look up one customer.
select s.* from public.subscriptions s
join public.profiles p on p.id = s.user_id
where p.email = 'customer@example.com';

-- Was a specific delivery already processed?
select * from public.billing_event_log where event_id = '<webhook-id>';
```

### Manual reconciliation (last resort — prefer replay)

Only when a legit event genuinely can't be replayed. Verify against Polar's
dashboard first, and act as service-role.

```sql
-- Grant premium (mirror an 'active' event). current_period_end from Polar.
update public.subscriptions
set tier = 'premium', status = 'active', current_period_end = '<iso-ts>'
where user_id = '<user-uuid>';

-- Revoke (mirror `subscription.revoked`).
update public.subscriptions
set tier = 'free', status = 'canceled', current_period_end = null
where user_id = '<user-uuid>';
```

## Env vars this path depends on

`POLAR_WEBHOOK_SECRET` (signature), `POLAR_SERVER` (**must be `production` in
prod**), `POLAR_PRODUCT_HOSTED` / `POLAR_PRODUCT_LEAD` (product guard), and the
Supabase service-role env used by `defaultSupabaseAdmin()`. See
`docs/launch/m4-blind-launch-handback.md` §3 for the full map.
