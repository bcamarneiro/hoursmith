-- Per-user fixed-window rate limiter for the hosted proxy (ADA-302).
--
-- A fixed-window counter keyed on (user_id, window_start). The proxy computes
-- the window start (floor of now to the 5-minute boundary) and calls
-- increment_rate_limit() once per request; the function atomically bumps the
-- counter and returns the post-increment count, so concurrent requests in the
-- same window can't race past the limit.
--
-- Service-role only: the proxy reaches this via the service-role key, which
-- bypasses RLS. RLS is enabled with no policies so anon/authenticated have no
-- access.
--
-- Cleanup of stale windows is intentionally out of scope for the week-1
-- limiter; a future pg_cron job (or a TTL policy) can prune rows older than a
-- day. Rows are tiny and the PK keeps lookups fast regardless.

create table if not exists public.rate_limit_counters (
	user_id uuid not null,
	window_start timestamptz not null,
	count integer not null default 0,
	primary key (user_id, window_start)
);

alter table public.rate_limit_counters enable row level security;

-- Atomic increment: insert the window row at 1, or bump an existing one, and
-- return the resulting count. SECURITY DEFINER so the service role executes it
-- with the owner's rights regardless of RLS.
create or replace function public.increment_rate_limit(
	p_user_id uuid,
	p_window_start timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
	new_count integer;
begin
	insert into public.rate_limit_counters (user_id, window_start, count)
	values (p_user_id, p_window_start, 1)
	on conflict (user_id, window_start)
	do update set count = public.rate_limit_counters.count + 1
	returning count into new_count;
	return new_count;
end;
$$;
