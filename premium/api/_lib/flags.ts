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
