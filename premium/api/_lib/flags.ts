/**
 * Operational kill switches (ADA-341).
 *
 * Resolution precedence for every flag:
 *   1. Edge Config value (live, flip without redeploy)  — readEdgeConfig
 *   2. Per-environment env-var fallback                  — the `env` argument
 *   3. Hardcoded safe default
 *
 * Backed by Vercel Edge Config rather than the Next-oriented `flags` SDK:
 * Hoursmith ships as an Rspack SPA + @vercel/node edge functions, not a Next
 * app. These function-shaped helpers keep call sites flag-like so a later swap
 * to the SDK needs no call-site changes. The `env` argument (defaulting to
 * `process.env`) lets handlers thread their injected env through for testing.
 *
 * Edge Config schema (v1):
 *   paywall_public: boolean
 *   paywall_allow_emails: string[]   // "*" = everyone
 *   polar_checkout_enabled: boolean
 *   maintenance_mode: boolean
 *   announcement_banner: string | null
 */

import { readEdgeConfig } from './edgeConfig.js';

type Env = Partial<Record<string, string | undefined>>;

export interface PublicFlags {
	maintenanceMode: boolean;
	checkoutEnabled: boolean;
	paywallPublic: boolean;
	paywallOpenForMe: boolean;
	announcementBanner: string | null;
}

function envPaywallPublic(env: Env): boolean | undefined {
	const v = env.PAYWALL_PUBLIC;
	if (v === undefined) return undefined;
	// Stored as the keyword 'open'/'closed' so Vercel doesn't auto-parse it.
	return v === 'open';
}

function envAllowEmails(env: Env): string[] {
	return (env.PAYWALL_ALLOW_EMAILS ?? '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

async function boolFlag(
	key: string,
	envFallback: boolean | undefined,
	hardDefault: boolean,
): Promise<boolean> {
	const fromEdge = await readEdgeConfig<boolean>(key);
	if (typeof fromEdge === 'boolean') return fromEdge;
	if (envFallback !== undefined) return envFallback;
	return hardDefault;
}

export function paywallPublic(env: Env = process.env): Promise<boolean> {
	return boolFlag('paywall_public', envPaywallPublic(env), false);
}

export function checkoutEnabled(_env: Env = process.env): Promise<boolean> {
	// No env-var fallback by design — checkout defaults ON; only Edge Config
	// can disable it (a deliberate, live kill switch).
	return boolFlag('polar_checkout_enabled', undefined, true);
}

export function maintenanceMode(_env: Env = process.env): Promise<boolean> {
	return boolFlag('maintenance_mode', undefined, false);
}

export async function paywallAllowEmails(
	env: Env = process.env,
): Promise<string[]> {
	const fromEdge = await readEdgeConfig<unknown>('paywall_allow_emails');
	if (Array.isArray(fromEdge)) {
		return fromEdge.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
	}
	return envAllowEmails(env);
}

export async function announcementBanner(
	_env: Env = process.env,
): Promise<string | null> {
	const fromEdge = await readEdgeConfig<string | null>('announcement_banner');
	return fromEdge ?? null;
}

/** Is this email on the allowlist (or is the allowlist a wildcard)? */
export async function isAllowlisted(
	email: string | null,
	env: Env = process.env,
): Promise<boolean> {
	const allow = await paywallAllowEmails(env);
	if (allow.includes('*')) return true;
	if (!email) return false;
	return allow.includes(email.toLowerCase());
}

/** Server-side checkout gate: may this email start a checkout right now? */
export async function canCheckout(
	email: string | null,
	env: Env = process.env,
): Promise<boolean> {
	if (await paywallPublic(env)) return true;
	return isAllowlisted(email, env);
}

/**
 * Write flag values to Edge Config. Only the fields present in `patch` are
 * updated; omitted fields keep their current value. Needs `VERCEL_API_TOKEN`
 * and `EDGE_CONFIG` (the connection string) to be set in the environment.
 *
 * Returns `null` on success or an error message string on failure.
 */
export async function writeFlags(
	patch: Partial<PublicFlags>,
): Promise<string | null> {
	const token = process.env.VERCEL_API_TOKEN;
	const connection = process.env.EDGE_CONFIG;
	if (!token || !connection) {
		return 'edge_config_not_configured';
	}
	try {
		const url = new URL(connection);
		const base = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
		const edgeConfigId = url.pathname.split('/').pop() || '';
		if (!edgeConfigId) return 'invalid_edge_config';

		const vercelApiBase = 'https://api.vercel.com/v1/edge-config';
		const itemsUrl = `${vercelApiBase}/${encodeURIComponent(edgeConfigId)}/items`;

		const keyToEdgeKey: Record<string, string> = {
			maintenanceMode: 'maintenance_mode',
			checkoutEnabled: 'polar_checkout_enabled',
			paywallPublic: 'paywall_public',
			paywallOpenForMe: 'paywall_public',
			announcementBanner: 'announcement_banner',
		};

		const items: Array<{ operation: 'upsert'; key: string; value: unknown }> =
			[];
		for (const [field, value] of Object.entries(patch)) {
			const edgeKey = keyToEdgeKey[field];
			if (!edgeKey) continue;
			// paywallOpenForMe is computed per-user, never stored directly
			if (field === 'paywallOpenForMe') continue;
			items.push({ operation: 'upsert', key: edgeKey, value });
		}

		if (items.length === 0) return null;

		const res = await fetch(itemsUrl, {
			method: 'PATCH',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ items }),
		});

		if (!res.ok) return `edge_config_write_failed: ${res.status}`;
		return null;
	} catch (err) {
		return `edge_config_write_error: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/** Resolve the public flag snapshot for a given (optional) caller email. */
export async function resolveFlags(
	email: string | null,
	env: Env = process.env,
): Promise<PublicFlags> {
	const [paywall, checkout, maintenance, openForMe, banner] = await Promise.all(
		[
			paywallPublic(env),
			checkoutEnabled(env),
			maintenanceMode(env),
			canCheckout(email, env),
			announcementBanner(env),
		],
	);
	return {
		maintenanceMode: maintenance,
		checkoutEnabled: checkout,
		paywallPublic: paywall,
		paywallOpenForMe: openForMe,
		announcementBanner: banner,
	};
}
