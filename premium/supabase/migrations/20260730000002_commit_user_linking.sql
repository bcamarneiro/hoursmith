-- Commit-User Linking for Hoursmith Premium (ADA-639).
--
-- Adds user association (user_id) to the commits table for direct ownership
-- attribution. A commit is associated with the auth user who imported/owns it,
-- while profile_commits handles team-level attribution (pair programming,
-- multi-assignee).
--
-- Handles both greenfield creation and migration from ada-605's schema (which
-- created the tables without user_id). Uses IF NOT EXISTS throughout so this
-- migration is idempotent regardless of apply order.
--
-- Linear: ADA-639.

-- ---------------------------------------------------------------------------
-- commits — one row per unique (repository, sha) pair.
-- Created with user_id; if the table already exists (from ada-605), the
-- ALTER TABLE below adds user_id separately.
-- ---------------------------------------------------------------------------

create table if not exists public.commits (
    id uuid primary key default gen_random_uuid(),
    sha text not null,
    repository text not null,
    message text,
    author_name text,
    author_email text,
    authored_at timestamptz,
    source text not null,
    user_id uuid references auth.users (id) on delete set null,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    constraint commits_repo_sha_uniq unique (repository, sha),
    constraint commits_source_check
        check (source in ('gitlab', 'github', 'bitbucket', 'manual'))
);

-- If the table was already created by ada-605 without user_id, add it now.
-- No-op if user_id already exists (the CREATE TABLE above covered it).
alter table public.commits
    add column if not exists user_id uuid references auth.users (id) on delete set null;

-- RLS (safe to call multiple times).
alter table public.commits enable row level security;

-- Unified select policy: users see commits they own (user_id) OR commits
-- associated with their profile via the join table.
drop policy if exists "commits_select_associated" on public.commits;

create policy "commits_select_owned_or_associated"
    on public.commits for select
    using (
        auth.uid() = user_id
        or
        exists (
            select 1
            from public.profile_commits
            where profile_commits.commit_id = commits.id
              and profile_commits.profile_id = auth.uid()
        )
    );

-- ---------------------------------------------------------------------------
-- Indexes for user-association queries
-- ---------------------------------------------------------------------------

-- Direct user_id lookup: "commits owned by user X".
create index if not exists commits_user_id_idx
    on public.commits (user_id);

-- Composite: recent commits by user (most common query pattern).
create index if not exists commits_user_id_authored_at_idx
    on public.commits (user_id, authored_at desc);

-- ---------------------------------------------------------------------------
-- profile_commits — many-to-many join between profiles and commits.
-- Unchanged from ada-605; user association is handled by commits.user_id.
-- ---------------------------------------------------------------------------

create table if not exists public.profile_commits (
    profile_id uuid not null references public.profiles (id) on delete cascade,
    commit_id uuid not null references public.commits (id) on delete cascade,
    source text not null,
    matched_at timestamptz not null default now(),
    primary key (profile_id, commit_id),
    constraint profile_commits_source_check
        check (source in ('email-match', 'gitlab-import', 'github-import', 'manual'))
);

alter table public.profile_commits enable row level security;

-- Profiles see their own associations.
create policy "profile_commits_select_own"
    on public.profile_commits for select
    using (profile_id = auth.uid());

-- Lookup all commits for a profile (main query path).
create index if not exists profile_commits_profile_id_idx
    on public.profile_commits (profile_id);

-- Reverse lookup: which profiles are associated with a given commit.
create index if not exists profile_commits_commit_id_idx
    on public.profile_commits (commit_id);
