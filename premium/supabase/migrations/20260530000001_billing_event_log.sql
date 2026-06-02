-- Billing webhook idempotency log (ADA-308).
--
-- Records the Standard Webhooks delivery id (`webhook-id` header) of every
-- Polar event we accept, so a duplicate delivery is short-circuited instead of
-- re-running the subscription upsert. The webhook path does an
-- INSERT ... ON CONFLICT DO NOTHING (PostgREST `resolution=ignore-duplicates`)
-- and treats "no row inserted" as a duplicate.
--
-- Service-role only: the premium functions reach this via the service-role key,
-- which bypasses RLS. RLS is enabled with no policies so anon/authenticated
-- clients have no access.

create table if not exists public.billing_event_log (
	event_id text primary key,
	processed_at timestamptz not null default now()
);

alter table public.billing_event_log enable row level security;
