/**
 * Thin, fail-safe reader over Vercel Edge Config (ADA-341).
 *
 * Edge Config backs the operational kill switches (paywall / checkout /
 * maintenance). We read it over its plain REST endpoint with `fetch` rather
 * than the `@vercel/edge-config` SDK: this is edge-runtime-native and keeps the
 * function free of an extra dependency. The `EDGE_CONFIG` connection string is
 * the base URL plus a read `token` query param, e.g.
 *   https://edge-config.vercel.com/ecfg_xxx?token=yyy
 * and a single item is read at `<base>/item/<key>?token=yyy`.
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
