-- Unified absence schema for Hoursmith Premium.
--
-- Normalizes absence data from all incoming providers (ICS feeds, manual
-- entries, future Jira-based detection, etc.) into per-user per-date records.
-- Each row represents one absence day for one user from one provider; multiple
-- providers contributing the same date are coalesced client-side via the
-- existing AbsenceDay.reasons[] merge logic.
--
-- This schema is the foundation for a future sync layer that replaces the
-- current purely-client-side ICS parsing with a server-side absence store.
-- For now, the client continues to fetch and parse ICS feeds directly; the
-- DB gives queryable, provider-tracked absence data that survives page reloads
-- and enables server-side absence consolidation across sources.
--
-- Linear: ADA-602.

-- ---------------------------------------------------------------------------
-- absence_providers: configuration for each absence data source.
--
-- One row per provider per user. The `config` jsonb column holds
-- provider-specific settings (title filters, attribution mode, JQL queries)
-- so the schema stays generic across source types without per-provider columns.
--
-- Providers are user-owned and RLS-scoped: users manage their own sources.
-- ---------------------------------------------------------------------------

create table if not exists public.absence_providers (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    provider_type text not null check (provider_type in ('ics', 'manual')),
    label text not null,
    url text,
    config jsonb not null default '{}'::jsonb,
    enabled boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.absence_providers enable row level security;

create policy "absence_providers_select_own"
    on public.absence_providers for select
    using (auth.uid() = user_id);

create policy "absence_providers_insert_own"
    on public.absence_providers for insert
    with check (auth.uid() = user_id);

create policy "absence_providers_update_own"
    on public.absence_providers for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "absence_providers_delete_own"
    on public.absence_providers for delete
    using (auth.uid() = user_id);

create index if not exists absence_providers_user_id_idx
    on public.absence_providers (user_id);

-- Trigger: keep updated_at fresh on every write.
create trigger absence_providers_set_updated_at
    before update on public.absence_providers
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- user_absences: one row per (user, date, provider) for each absence day.
--
-- The `absence_kind` check constraint mirrors the client-side AbsenceKind
-- union ('vacation', 'sick', 'off', 'holiday'). Each row carries the reason
-- string from its source event and a metadata jsonb bag for provider-specific
-- extras (original ICS summary, sync id, Jira issue key, etc.).
--
-- Multiple providers may contribute the same date for the same user (e.g. a
-- company-wide holiday from an ICS feed and a personal vacation day entered
-- manually). The client merge logic (addAbsenceReason / resolveAbsenceKind in
-- absenceService.ts) resolves the winning AbsenceKind and accumulates reasons.
--
-- The partial unique index on (user_id, absence_date, provider_id) makes
-- re-syncs idempotent: re-fetching the same provider emits INSERT ... ON
-- CONFLICT DO NOTHING without application-level dedup. Rows with a null
-- provider_id (e.g. legacy imports) are excluded from this constraint.
-- ---------------------------------------------------------------------------

create table if not exists public.user_absences (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    provider_id uuid references public.absence_providers (id) on delete set null,
    absence_date date not null,
    kind text not null check (kind in ('vacation', 'sick', 'off', 'holiday')),
    reason text not null default '',
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.user_absences enable row level security;

-- Unique constraint: idempotent re-sync per (user, date, provider).
-- Null provider_id rows (legacy/manual) bypass the constraint.
create unique index if not exists user_absences_user_date_provider_uniq
    on public.user_absences (user_id, absence_date, provider_id)
    where provider_id is not null;

create index if not exists user_absences_user_id_date_idx
    on public.user_absences (user_id, absence_date desc);

create policy "user_absences_select_own"
    on public.user_absences for select
    using (auth.uid() = user_id);

create policy "user_absences_insert_own"
    on public.user_absences for insert
    with check (auth.uid() = user_id);

create policy "user_absences_update_own"
    on public.user_absences for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "user_absences_delete_own"
    on public.user_absences for delete
    using (auth.uid() = user_id);

-- Trigger: keep updated_at fresh on every write.
create trigger user_absences_set_updated_at
    before update on public.user_absences
    for each row execute function public.set_updated_at();
