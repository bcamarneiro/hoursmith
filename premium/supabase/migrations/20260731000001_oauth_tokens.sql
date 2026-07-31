-- OAuth token storage for Hoursmith Premium (ADA-680).
--
-- Stores encrypted OAuth credentials (access token, refresh token, expiry)
-- per user and provider so server-side API integrations can refresh and use
-- them without the tokens ever landing in a browser context.
-- Tokens are encrypted at rest; the plaintext is derived only during API
-- calls and never persisted.
--
-- One token per (user_id, provider) — a new upsert overwrites the old value.
-- Lifecycle: upsert overwrites; revoke transitions to 'revoked'; delete is
-- the terminal state (CASCADE from auth.users covers that).
--
-- RLS: users can read, upsert, and delete their own rows.
-- Service-role writes (backend API integrations) bypass RLS.

create table public.oauth_tokens (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    provider text not null,
    label text,
    encrypted_access_token text not null,
    encrypted_refresh_token text,
    expires_at timestamptz,
    token_type text,
    scope text,
    status text not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint oauth_tokens_provider_check
        check (provider in ('jira_oauth', 'gitlab_oauth', 'github_oauth', 'custom')),
    constraint oauth_tokens_status_check
        check (status in ('active', 'revoked')),
    constraint oauth_tokens_user_provider_uniq
        unique (user_id, provider),
    -- Refresh token is required on insert unless the flow is auth-code-only
    -- (in which case the caller passes an empty string). We enforce non-null
    -- access token, but allow nullable refresh token for code-grant-only flows.
    constraint oauth_tokens_access_token_not_empty
        check (length(encrypted_access_token) > 0)
);

alter table public.oauth_tokens enable row level security;

-- Users manage their own OAuth tokens: read, insert, update, delete.
create policy "oauth_tokens_select_own"
    on public.oauth_tokens for select
    using (auth.uid() = user_id);

create policy "oauth_tokens_insert_own"
    on public.oauth_tokens for insert
    with check (auth.uid() = user_id);

create policy "oauth_tokens_update_own"
    on public.oauth_tokens for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "oauth_tokens_delete_own"
    on public.oauth_tokens for delete
    using (auth.uid() = user_id);

-- Reuse the existing updated_at trigger from init_paywall.
create trigger oauth_tokens_set_updated_at
    before update on public.oauth_tokens
    for each row execute function public.set_updated_at();

-- Index for fast lookup by user.
create index oauth_tokens_user_id_idx
    on public.oauth_tokens (user_id);

-- Index for finding tokens nearing expiry (proactive refresh).
create index oauth_tokens_expires_at_idx
    on public.oauth_tokens (expires_at)
    where expires_at is not null;
