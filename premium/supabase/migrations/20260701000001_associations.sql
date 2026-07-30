-- Association webhook idempotency + store (ADA-640).
--
-- Records links between external entities (calendar events, git commits,
-- RescueTime activities) and Jira issues, pushed by external services or
-- automation via the /api/association/webhook endpoint.
--
-- An atomic upsert (INSERT ... ON CONFLICT DO UPDATE) means the webhook is
-- idempotent: re-delivering the same (user_id, external_source, issue_key)
-- updates the external_id and metadata rather than creating a duplicate.
--
-- Service-role only: the premium functions reach this via the service-role key,
-- which bypasses RLS. RLS is enabled with no policies so anon/authenticated
-- clients have no access.

create table if not exists public.associations (
    user_id         text        not null,
    external_source text        not null,
    external_id     text        not null,
    issue_key       text        not null,
    issue_summary   text,
    title_pattern   text,
    event_time      timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- One association per (user, source, issue) — upsert by these three.
create unique index if not exists idx_associations_unique
    on public.associations (user_id, external_source, issue_key);

-- Speed lookups by external source + id (the reverse lookup path).
create index if not exists idx_associations_external
    on public.associations (external_source, external_id);

alter table public.associations enable row level security;
