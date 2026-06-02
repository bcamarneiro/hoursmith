/**
 * Per-user fixed-window rate limiter for the hosted proxy (ADA-302).
 *
 * A €-cheap subscriber could otherwise drive unbounded Vercel invocations and
 * bandwidth through the proxy. Per the PM R2 compromise this is a *simple*
 * week-1 limiter, not a sliding-window Redis system: a fixed window counter
 * keyed on the Supabase user id, backed by a Postgres table via an atomic
 * `increment_rate_limit` RPC (INSERT ... ON CONFLICT DO UPDATE count + 1) so
 * concurrent requests don't race.
 *
 * Limit: 200 requests / 5-minute window per user — generous for real timesheet
 * use (a month view fans out to ~30-40 calls) but a tarpit for a scraper.
 *
 * Fail-open: if the store is unreachable/misconfigured we ALLOW the request and
 * log a warning. For a week-1 limiter, availability beats strict enforcement;
 * the SSRF guard (ADA-296) is the hard security boundary, this is cost control.
 *
 * Edge-runtime compatible: dependency-free `fetch`, mirroring entitlement.ts.
 */

export const RATE_LIMIT_WINDOW_SECONDS = 300;
export const RATE_LIMIT_MAX_REQUESTS = 200;

export interface RateLimitResult {
	allowed: boolean;
	/** Seconds until the current window resets (for the `Retry-After` header). */
	retryAfterSeconds: number;
	/** The count after this request, or null when the store failed (fail-open). */
	count: number | null;
}

/**
 * The persistence the limiter needs: atomically increment the counter for
 * `(userId, windowStart)` and return the resulting count. Injected in tests;
 * defaults to a PostgREST-backed store.
 */
export interface RateLimitStore {
	increment(userId: string, windowStartIso: string): Promise<number>;
}

type Env = Partial<Record<string, string | undefined>>;

export interface CheckRateLimitOptions {
	store?: RateLimitStore;
	/** Override "now" (ms) in tests. Defaults to `Date.now()`. */
	nowMs?: number;
	env?: Env;
}

/**
 * PostgREST-backed store calling the `increment_rate_limit` Postgres function
 * with the service-role key. Returns the post-increment count.
 */
export class PostgrestRateLimitStore implements RateLimitStore {
	constructor(
		private readonly url: string,
		private readonly serviceRoleKey: string,
	) {}

	async increment(userId: string, windowStartIso: string): Promise<number> {
		const res = await fetch(`${this.url}/rest/v1/rpc/increment_rate_limit`, {
			method: 'POST',
			headers: {
				apikey: this.serviceRoleKey,
				authorization: `Bearer ${this.serviceRoleKey}`,
				'content-type': 'application/json',
				accept: 'application/json',
			},
			body: JSON.stringify({
				p_user_id: userId,
				p_window_start: windowStartIso,
			}),
		});
		if (!res.ok) {
			throw new Error(`increment_rate_limit failed: ${res.status}`);
		}
		const value = (await res.json()) as unknown;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new Error('increment_rate_limit returned a non-numeric result');
		}
		return value;
	}
}

function defaultStore(env: Env): RateLimitStore | null {
	const url = env.SUPABASE_URL;
	const key = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) return null;
	return new PostgrestRateLimitStore(url, key);
}

/** Start of the fixed window containing `nowMs`, as an ISO string. */
function windowStart(nowMs: number): { iso: string; resetMs: number } {
	const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
	const startMs = Math.floor(nowMs / windowMs) * windowMs;
	return { iso: new Date(startMs).toISOString(), resetMs: startMs + windowMs };
}

/**
 * Check (and consume) one request against the user's fixed-window quota.
 * Returns `allowed: false` once the count exceeds the limit. Fails open on any
 * store error.
 */
export async function checkRateLimit(
	userId: string,
	options: CheckRateLimitOptions = {},
): Promise<RateLimitResult> {
	const env = options.env ?? process.env;
	const nowMs = options.nowMs ?? Date.now();
	const store = options.store ?? defaultStore(env);

	const { iso, resetMs } = windowStart(nowMs);
	const retryAfterSeconds = Math.max(1, Math.ceil((resetMs - nowMs) / 1000));

	if (!store) {
		// Misconfigured store → fail open (no env in some preview/test contexts).
		return { allowed: true, retryAfterSeconds, count: null };
	}

	try {
		const count = await store.increment(userId, iso);
		return {
			allowed: count <= RATE_LIMIT_MAX_REQUESTS,
			retryAfterSeconds,
			count,
		};
	} catch (err) {
		console.warn(
			JSON.stringify({
				ts: new Date().toISOString(),
				svc: 'hoursmith-proxy',
				code: 'rate_limit_store_unavailable',
				note: (err as Error).message,
			}),
		);
		return { allowed: true, retryAfterSeconds, count: null };
	}
}
