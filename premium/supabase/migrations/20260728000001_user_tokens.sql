-- Encrypted third-party token storage for Hoursmith Premium (ADA-648).
--
-- Stores encrypted API tokens (Jira, GitLab, RescueTime, etc.) per user so
-- the hosted proxy can inject them server-side without the token ever landing
-- in a browser context. Tokens are encrypted at rest; the plaintext is
-- derived only during request forwarding and never persisted.
--
-- One token per (user_id, provider) — a new upsert overwrites the old value.
-- Lifecycle:  created → active → (revoked / expired).
--   active   = usable, included in proxy forwarding
--   revoked  = user explicitly removed access
--   expired  = known-to-be-stale (e.g. GitLab PAT with an expiry date)
-- A deleted row is the terminal state (CASCADE from auth.users covers that).
--
-- RLS: users can read, update, and delete their own rows.
-- Service-role writes (via the hosted proxy or account management) bypass RLS.
--
-- Idempotent: safe to run multiple times. Uses IF NOT EXISTS throughout so
-- this migration is a no-op when applied against a database that already has
-- the user_tokens table (e.g. from a prior non-idempotent apply).

-- ---------------------------------------------------------------------------
-- Table: one row per (user_id, provider), upserted on re-auth.
-- ---------------------------------------------------------------------------

create table if not exists public.user_tokens (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    provider text not null,
    label text,
    encrypted_value text not null,
    status text not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_used_at timestamptz,

    constraint user_tokens_provider_check
        check (provider in ('jira_api', 'gitlab', 'rescuetime', 'github', 'toggl', 'harvest', 'clockify', 'custom')),
    constraint user_tokens_status_check
        check (status in ('active', 'revoked', 'expired')),
    constraint user_tokens_user_provider_uniq
        unique (user_id, provider)
);

-- RLS (safe to call multiple times).
alter table public.user_tokens enable row level security;

-- Policies: drop-then-create so re-runs pick up any definition changes.
drop policy if exists "user_tokens_select_own" on public.user_tokens;
drop policy if exists "user_tokens_insert_own" on public.user_tokens;
drop policy if exists "user_tokens_update_own" on public.user_tokens;
drop policy if exists "user_tokens_delete_own" on public.user_tokens;

-- Users manage their own tokens: create, read, update, delete.
create policy "user_tokens_select_own"
    on public.user_tokens for select
    using (auth.uid() = user_id);

create policy "user_tokens_insert_own"
    on public.user_tokens for insert
    with check (auth.uid() = user_id);

create policy "user_tokens_update_own"
    on public.user_tokens for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "user_tokens_delete_own"
    on public.user_tokens for delete
    using (auth.uid() = user_id);

-- Trigger: keep updated_at fresh on every write.
-- Reuses the public.set_updated_at() function defined in the init_paywall
-- migration. Drop first so re-runs are safe.
drop trigger if exists user_tokens_set_updated_at on public.user_tokens;

create trigger user_tokens_set_updated_at
    before update on public.user_tokens
    for each row execute function public.set_updated_at();

-- Indexes (IF NOT EXISTS makes re-runs no-ops).
-- Fast lookup by user.
create index if not exists user_tokens_user_id_idx
    on public.user_tokens (user_id);

-- Find tokens that haven't been used recently (cleanup / expiry).
create index if not exists user_tokens_last_used_at_idx
    on public.user_tokens (last_used_at)
    where last_used_at is not null;
