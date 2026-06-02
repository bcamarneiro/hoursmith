/**
 * Resolve the email on a Supabase JWT via GoTrue (ADA-341).
 *
 * The paywall allowlist gates by email *before* a subscription exists, so the
 * subscription-oriented entitlement check (entitlement.ts) doesn't fit. This
 * does the minimal GoTrue `GET /auth/v1/user` lookup and returns the email, or
 * `null` if the token is missing/invalid or the server isn't configured. Never
 * throws — callers treat `null` as "not allowlisted".
 */

type Env = Partial<Record<string, string | undefined>>;

export async function emailFromToken(
	token: string,
	env: Env = process.env,
): Promise<string | null> {
	const url = env.SUPABASE_URL;
	const key = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) return null;
	try {
		const res = await fetch(`${url}/auth/v1/user`, {
			headers: { apikey: key, authorization: `Bearer ${token}` },
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { email?: string } | null;
		return body?.email ?? null;
	} catch {
		return null;
	}
}
