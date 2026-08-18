-- Absence webhook receiver storage for Hoursmith Premium (ADA-645).
--
-- The user_absences table stores per-user per-date absence records from
-- webhook-delivered external absence/calendar systems.  Uses (user_id,
-- absence_date, provider_id) unique constraint so webhook re-deliveries
-- are naturally idempotent (resolution=merge-duplicates in PostgREST).
--
-- Multiple providers may contribute the same date for the same user; the
-- client merge logic resolves the winning AbsenceKind and accumulates
-- reasons.
--
-- Linear: ADA-645.

create table if not exists public.user_absences (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    provider_id uuid,
    absence_date date not null,
    kind text not null check (kind in ('vacation', 'sick', 'off', 'holiday')),
    reason text not null default '',
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Idempotent re-sync per (user, date, provider).
-- Null provider_id rows bypass the constraint (ad-hoc / legacy).
create unique index if not exists user_absences_user_date_provider_uniq
    on public.user_absences (user_id, absence_date, provider_id)
    where provider_id is not null;

create index if not exists user_absences_user_id_date_idx
    on public.user_absences (user_id, absence_date desc);

alter table public.user_absences enable row level security;

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

create trigger user_absences_set_updated_at
    before update on public.user_absences
    for each row execute function public.set_updated_at();
