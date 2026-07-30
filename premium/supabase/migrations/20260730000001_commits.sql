-- Commit tracking tables for Hoursmith Premium (ADA-605).
--
-- Two tables:
--   1. commits          — individual git commits from connected VCS accounts
--   2. profile_commits  — many-to-many join linking commits to Hoursmith profiles
--
-- Service-role is the primary writer (Premium sync functions ingest commits via
-- GitLab/GitHub APIs). Profiles can read their own associated commits via RLS.
--
-- Linear: ADA-605.

-- ---------------------------------------------------------------------------
-- commits: one row per unique (repository, sha) pair.
--
-- Purpose: store the VCS commits that Powered Hoursmith users have pushed,
-- along with enough metadata to associate them to issues and attribute
-- contribution value. The raw commit data is ingested by Premium sync
-- functions (service-role); no anon/authenticated client writes here.
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
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now(),
    constraint commits_repo_sha_uniq unique (repository, sha),
    constraint commits_source_check
        check (source in ('gitlab', 'github', 'bitbucket', 'manual'))
);

alter table public.commits enable row level security;

-- Profiles can see commits associated with them via the join table. Since
-- commits may be shared across profiles (pair-programming, multi-assignee),
-- we provide an overlapping policy — a user sees a commit if *any* profile
-- they can see is linked to it. In practice this is a self-reference: each
-- user sees commits their own profile is associated with.
create policy "commits_select_associated"
    on public.commits for select
    using (
        exists (
            select 1
            from public.profile_commits
            where profile_commits.commit_id = commits.id
              and profile_commits.profile_id = auth.uid()
        )
    );

-- No insert/update/delete policies for users → all writes go through
-- service-role (Premium sync functions).

-- Index for fast lookups by source + authored_at (the common query pattern).
create index commits_source_authored_at_idx
    on public.commits (source, authored_at desc);

-- Index for dedup / lookup by repository + sha.
create index commits_repository_sha_idx
    on public.commits (repository, sha);

-- ---------------------------------------------------------------------------
-- profile_commits: many-to-many join between profiles and commits.
--
-- A commit can be linked to multiple profiles (pair programming, shared
-- authorship) and a profile can have many commits. The join is established
-- by Premium sync functions via email-matching or explicit repository config.
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

-- Profiles can see their own associations.
create policy "profile_commits_select_own"
    on public.profile_commits for select
    using (profile_id = auth.uid());

-- No insert/update/delete policies for users → all writes go through
-- service-role (Premium sync functions).

-- Index for looking up all commits for a profile (the main query path).
create index profile_commits_profile_id_idx
    on public.profile_commits (profile_id);

-- Index for reverse lookup: which profiles are associated with a given commit.
create index profile_commits_commit_id_idx
    on public.profile_commits (commit_id);
