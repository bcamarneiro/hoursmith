-- Reminder-email substrate (ADA-546, split from ADA-389): the flagship Hosted
-- paid hook — the server chases incomplete timesheets so the lead never has to.
--
-- PRIVACY INVARIANT: store the *minimum*. A per-member/period completeness flag
-- and a delivery token — NEVER worklog detail, hours, or issue keys. The browser
-- computes completeness locally and syncs only the boolean here, so no worklog
-- content ever leaves the client. This substrate is reused by every later
-- channel (webhooks → Web Push → Slack → Teams, ADA-389).
--
-- RLS: a lead (authenticated user) owns their own settings + state rows; the
-- cron runs with the service-role key, which bypasses RLS.

-- Per-lead reminder configuration (opt-in). One row per lead.
create table public.reminder_settings (
    user_id uuid primary key references auth.users (id) on delete cascade,
    enabled boolean not null default false,
    member_nudge boolean not null default true,
    lead_digest boolean not null default true,
    lead_email text,
    team_name text,
    updated_at timestamptz not null default now()
);

alter table public.reminder_settings enable row level security;

create policy "reminder_settings self access"
    on public.reminder_settings
    for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- Minimal completeness state per lead / member / reporting period.
-- `period_key` is an opaque label (e.g. an ISO week start) computed client-side.
-- `delivery_token` gives idempotent sends + one-click unsubscribe; `sent_at`
-- marks that this member/period was already nudged so a cron re-run is a no-op.
create table public.reminder_completeness_state (
    id uuid primary key default gen_random_uuid(),
    owner_user_id uuid not null references auth.users (id) on delete cascade,
    member_email text not null,
    display_name text not null default '',
    period_key text not null,
    complete boolean not null default false,
    on_leave boolean not null default false,
    delivery_token text not null,
    sent_at timestamptz,
    updated_at timestamptz not null default now(),
    unique (owner_user_id, member_email, period_key)
);

alter table public.reminder_completeness_state enable row level security;

create policy "reminder_state self access"
    on public.reminder_completeness_state
    for all
    using (auth.uid() = owner_user_id)
    with check (auth.uid() = owner_user_id);

-- Cron scans due, still-incomplete, not-yet-sent rows across all leads.
create index reminder_state_due_idx
    on public.reminder_completeness_state (period_key)
    where complete = false and sent_at is null;
