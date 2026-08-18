-- ADA-631: raw commit table for GitLab webhook ingestion.
-- Stores the full payload as JSONB with indexed columns for querying.
-- Created: 2026-07-30

create table if not exists raw_commits (
	id bigserial primary key,
	project_id bigint not null,
	user_username text not null,
	ref text not null,
	commit_count integer not null default 0,
	pushed_at text not null,
	payload jsonb not null,
	status text not null default 'pending',
	created_at timestamptz not null default now()
);

-- Indexes for common query patterns
create index if not exists idx_raw_commits_project_id on raw_commits (project_id);
create index if not exists idx_raw_commits_user_username on raw_commits (user_username);
create index if not exists idx_raw_commits_ref on raw_commits (ref);
create index if not exists idx_raw_commits_status on raw_commits (status);
create index if not exists idx_raw_commits_pushed_at on raw_commits (pushed_at);

-- Row-level security: only service-role operations
alter table raw_commits enable row level security;

create policy "Service role can do anything on raw_commits"
	on raw_commits
	as permissive
	for all
	to service_role
	using (true)
	with check (true);
