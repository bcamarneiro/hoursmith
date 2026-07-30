-- Session lookup table and refresh token storage for Premium auth (ADA-613).
--
-- These tables provide direct database-level access to session and refresh
-- token data for fast lookup and token management. GoTrue manages the
-- authoritative auth schema internally; the Premium API uses these as a
-- queryable layer for session presence checks, token tracking, and future
-- server-side revocation workflows.
--
-- Service-role only: the Premium API reaches these via the service-role key,
-- which bypasses RLS. RLS is enabled with no policies so anon/authenticated
-- roles have no access.

-- ---------------------------------------------------------------------------
-- sessions: one row per active user session.
-- ---------------------------------------------------------------------------

create table if not exists public.sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    expires_at timestamptz not null,
    ip_address text,
    user_agent text
);

alter table public.sessions enable row level security;

-- Fast session lookup by user (common query: "find all sessions for this user").
create index sessions_user_id_idx on public.sessions (user_id);

-- Efficient cleanup of expired sessions (background sweep or maintenance task).
create index sessions_expires_at_idx on public.sessions (expires_at);

-- Keep updated_at fresh on writes.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger sessions_set_updated_at
    before update on public.sessions
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- refresh_tokens: one row per issued refresh token.
-- ---------------------------------------------------------------------------

create table if not exists public.refresh_tokens (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references public.sessions (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    token_hash text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked boolean not null default false
);

alter table public.refresh_tokens enable row level security;

-- Lookup all refresh tokens belonging to a session (for revoke-by-session).
create index refresh_tokens_session_id_idx on public.refresh_tokens (session_id);

-- Lookup all refresh tokens for a user (for global revoke workflows).
create index refresh_tokens_user_id_idx on public.refresh_tokens (user_id);

-- Fast lookup by token hash (for individual token verification / revocation).
create unique index refresh_tokens_token_hash_uniq on public.refresh_tokens (token_hash);

-- Efficient cleanup of expired tokens.
create index refresh_tokens_expires_at_idx on public.refresh_tokens (expires_at);

-- Keep updated_at fresh on token writes.
create trigger refresh_tokens_set_updated_at
    before update on public.refresh_tokens
    for each row execute function public.set_updated_at();
