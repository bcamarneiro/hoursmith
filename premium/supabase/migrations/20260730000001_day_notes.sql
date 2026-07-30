-- Day notes: per-user, per-date text notes synced from the client-side dayNotes
-- store (useUserDataStore). Service-role key is the primary writer (via
-- premium/api/day-notes); users also have RLS-scoped read/write access so the
-- client can read its own data without going through the edge function if
-- desired.
--
-- Linear: ADA-594.

create table public.day_notes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    date date not null,
    note text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint day_notes_user_date_uniq unique (user_id, date)
);

alter table public.day_notes enable row level security;

create policy "day_notes_select_own"
    on public.day_notes for select
    using (auth.uid() = user_id);

create policy "day_notes_insert_own"
    on public.day_notes for insert
    with check (auth.uid() = user_id);

create policy "day_notes_update_own"
    on public.day_notes for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "day_notes_delete_own"
    on public.day_notes for delete
    using (auth.uid() = user_id);

create trigger day_notes_set_updated_at
    before update on public.day_notes
    for each row execute function public.set_updated_at();
