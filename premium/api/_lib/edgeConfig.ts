/**
 * Thin, fail-safe reader/writer over Vercel Edge Config (ADA-341, ADA-620).
 *
 * Edge Config backs the operational kill switches (paywall / checkout /
 * maintenance). We read it over its plain REST endpoint with `fetch` rather
 * than the `@vercel/edge-config` SDK: this is edge-runtime-native and keeps the
 * function free of an extra dependency. The `EDGE_CONFIG` connection string is
 * the base URL plus a read `token` query param, e.g.
 *   https://edge-config.vercel.com/ecfg_xxx?token=***
 * and a single item is read at `<base>/item/<key>?token=yyy`.
 *
 * Writes go through the Vercel REST API (`PATCH /v1/edge-config/<id>/items`)
 * using `VERCEL_API_TOKEN` for auth, so the Edge Config ID is extracted from
 * the connection string URL path.
 *
 * Reads must never throw into a request handler: if the store is unconfigured
 * (no connection string) or a read fails, we return `undefined` so callers fall
 * back to the env-var / hardcoded default chain. Keeping the presence check here
 * also means unit tests with no connection string never touch the network.
 */

export async function readEdgeConfig<T>(key: string): Promise<T | undefined> {
	const connection = process.env.EDGE_CONFIG;
	if (!connection) return undefined;
	try {
		const url = new URL(connection);
		const base = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
		const res = await fetch(
			`${base}/item/${encodeURIComponent(key)}${url.search}`,
		);
		if (!res.ok) return undefined;
		return (await res.json()) as T;
	} catch {
		return undefined;
	}
}

/**
 * Extract the Edge Config resource ID (`ecfg_xxx`) from the `EDGE_CONFIG`
 * connection string URL path, or null if unconfigured / unparseable.
 */
function edgeConfigId(): string | null {
	const connection = process.env.EDGE_CONFIG;
	if (!connection) return null;
	try {
		const url = new URL(connection);
		return url.pathname.replace(/^\//, '').replace(/\/$/, '') || null;
	} catch {
		return null;
	}
}

/**
 * Write a single item to Vercel Edge Config via the Vercel REST API.
 *
 * Requires `VERCEL_API_TOKEN` (a Vercel access token with edge_config_write
 * scope) to be set in the environment. Extracts the Edge Config ID from the
 * `EDGE_CONFIG` connection string.
 *
 * Returns `true` on success, `false` if the store is unconfigured, the token
 * is missing, or the API call fails — never throws.
 */
export async function writeEdgeConfig(
	key: string,
	value: unknown,
): Promise<boolean> {
	const ecfgId = edgeConfigId();
	const token = process.env.VERCEL_API_TOKEN;
	if (!ecfgId || !token) return false;
	try {
		const res = await fetch(
			`https://api.vercel.com/v1/edge-config/${ecfgId}/items`,
			{
				method: 'PATCH',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					items: [{ operation: 'upsert', key, value }],
				}),
			},
		);
		return res.ok;
	} catch {
		return false;
	}
}