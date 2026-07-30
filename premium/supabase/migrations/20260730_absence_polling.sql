-- Server-side absence polling tables (ADA-604).
--
-- Two new tables move absence-data fetching from client-only (live ICS fetches
-- through the CORS proxy) to server-scheduled polling. The cron handler reads
-- feed configs from `user_calendar_feeds`, fetches & normalises the ICS, and
-- stores the results in `absence_records` for fast retrieval.
--
-- Writers (service-role only):
--   - cron handler: writes `absence_records`
--   - settings-sync endpoint (future): writes `user_calendar_feeds`
--
-- RLS is enabled with no policies on both tables so anon/authenticated clients
-- have no access. The cron handler and the settings-sync endpoint use the
-- service-role key, which bypasses RLS.
--
-- Linear: ADA-604.

-- ---------------------------------------------------------------------------
-- user_calendar_feeds: per-user ICS feed configuration
-- ---------------------------------------------------------------------------

create table if not exists public.user_calendar_feeds (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    url text not null,
    type text not null check (type in ('absence', 'holiday')),
    label text not null default '',
    absence_attribution text check (absence_attribution in ('self', 'shared')),
    title_filter text,
    enabled boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.user_calendar_feeds enable row level security;

create index user_calendar_feeds_user_id_idx
    on public.user_calendar_feeds (user_id);

create index user_calendar_feeds_enabled_idx
    on public.user_calendar_feeds (enabled)
    where enabled = true;

-- Trigger: keep updated_at fresh.
create trigger user_calendar_feeds_set_updated_at
    before update on public.user_calendar_feeds
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- user_absence_assignments: pattern-based email assignment for shared feeds
--   Mirrors the client-side AbsenceAssignment[] shape so the cron handler
--   can do server-side matching.
-- ---------------------------------------------------------------------------

create table if not exists public.user_absence_assignments (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    pattern text not null,
    user_emails text[] not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.user_absence_assignments enable row level security;

create index user_absence_assignments_user_id_idx
    on public.user_absence_assignments (user_id);

create trigger user_absence_assignments_set_updated_at
    before update on public.user_absence_assignments
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- absence_records: denormalised absence days produced by the cron handler
--   One row per (user_id, date). Overlapping reasons are merged.
-- ---------------------------------------------------------------------------

create table if not exists public.absence_records (
    id bigserial primary key,
    user_id uuid not null references public.profiles (id) on delete cascade,
    feed_id uuid references public.user_calendar_feeds (id) on delete set null,
    date date not null,
    kind text not null check (kind in ('vacation', 'sick', 'off', 'holiday')),
    summary text not null default '',
    reasons text[] not null default '{}',
    source text not null default 'cron',
    created_at timestamptz not null default now()
);

alter table public.absence_records enable row level security;

-- Unique: one row per user per day — upsert merges.
create unique index absence_records_user_date_uniq
    on public.absence_records (user_id, date);

-- Fast lookup for the frontend API.
create index absence_records_user_date_range_idx
    on public.absence_records (user_id, date);
