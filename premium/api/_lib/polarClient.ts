/**
 * Polar API client + webhook verifier for Hoursmith Premium.
 *
 * Replaces the Stripe SDK (`stripeClient.ts`) as part of the migration to Polar
 * as Merchant of Record (ADA-294). Dependency-free `fetch`/WebCrypto so every
 * handler stays edge-compatible — we deliberately do NOT bundle `@polar-sh/sdk`
 * into the edge functions.
 *
 * Two surfaces:
 *   - REST helpers (`createPolarCheckout`, `createPolarCustomerSession`,
 *     `cancelPolarSubscription`) — thin wrappers over `https://api.polar.sh/v1`.
 *   - `verifyPolarWebhook` — Standard Webhooks signature verification
 *     (HMAC-SHA256), the security gate on the webhook handler.
 *
 * Environment:
 *   - POLAR_ACCESS_TOKEN — Organization Access Token (server-only).
 *   - POLAR_SERVER       — "production" | "sandbox". Defaults to "sandbox" so a
 *                          misconfigured deploy can never accidentally touch the
 *                          live billing org.
 *
 * Linear: ADA-294.
 */

const SANDBOX_BASE = 'https://sandbox-api.polar.sh/v1';
const PRODUCTION_BASE = 'https://api.polar.sh/v1';

export interface PolarConfig {
	baseUrl: string;
	accessToken: string;
}

/** Injectable fetch so handlers stay testable without network. */
export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Resolve Polar config from the environment. Defaults to the **sandbox** base
 * URL when `POLAR_SERVER` is unset — a safe default that prevents an
 * unconfigured preview deploy from writing to the production org.
 */
export function defaultPolarConfig(
	env: Partial<Record<string, string | undefined>> = process.env,
): PolarConfig {
	const accessToken = env.POLAR_ACCESS_TOKEN;
	if (!accessToken) {
		throw new Error(
			'POLAR_ACCESS_TOKEN must be set in the Vercel environment.',
		);
	}
	const baseUrl =
		env.POLAR_SERVER === 'production' ? PRODUCTION_BASE : SANDBOX_BASE;
	return { baseUrl, accessToken };
}

interface PolarRequestDeps {
	config?: PolarConfig;
	fetchImpl?: FetchLike;
}

async function polarRequest(
	method: string,
	path: string,
	body: unknown,
	deps: PolarRequestDeps,
): Promise<unknown> {
	const config = deps.config ?? defaultPolarConfig();
	const fetchImpl = deps.fetchImpl ?? fetch;
	// Polar's API redirects path without a trailing slash (307); always include it.
	const url = `${config.baseUrl}${path}`;
	const res = await fetchImpl(url, {
		method,
		headers: {
			authorization: `Bearer ${config.accessToken}`,
			'content-type': 'application/json',
			accept: 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`polar ${method} ${path} failed: ${res.status} ${detail}`);
	}
	if (res.status === 204) return null;
	return res.json();
}

export interface CreateCheckoutInput {
	/** Polar product id for the chosen tier (Hosted / Lead). */
	productId: string;
	/** Our Supabase user id — linked to the Polar customer via external id. */
	customerExternalId: string;
	/** Where Polar redirects after a successful payment. */
	successUrl: string;
}

/**
 * Create a Polar Checkout Session and return its hosted URL. Verified shape
 * against the sandbox API: `POST /checkouts/` with `products: [id]`,
 * `customer_external_id`, `success_url`.
 */
export async function createPolarCheckout(
	input: CreateCheckoutInput,
	deps: PolarRequestDeps = {},
): Promise<{ url: string; id: string }> {
	const data = (await polarRequest(
		'POST',
		'/checkouts/',
		{
			products: [input.productId],
			customer_external_id: input.customerExternalId,
			success_url: input.successUrl,
		},
		deps,
	)) as { url?: string; id?: string };
	if (!data.url || !data.id) {
		throw new Error('polar checkout response missing url/id');
	}
	return { url: data.url, id: data.id };
}

/**
 * Create a Polar customer session and return the customer-portal URL, so the
 * subscriber can manage billing (update card, cancel, download invoices).
 * Looks the customer up by the external id we set at checkout (our user id).
 */
export async function createPolarCustomerSession(
	customerExternalId: string,
	deps: PolarRequestDeps = {},
): Promise<{ url: string }> {
	const data = (await polarRequest(
		'POST',
		'/customer-sessions/',
		{ customer_external_id: customerExternalId },
		deps,
	)) as { customer_portal_url?: string };
	if (!data.customer_portal_url) {
		throw new Error(
			'polar customer session response missing customer_portal_url',
		);
	}
	return { url: data.customer_portal_url };
}

/** Revoke a Polar subscription immediately (used by GDPR account deletion). */
export async function cancelPolarSubscription(
	subscriptionId: string,
	deps: PolarRequestDeps = {},
): Promise<void> {
	await polarRequest(
		'DELETE',
		`/subscriptions/${subscriptionId}`,
		undefined,
		deps,
	);
}

// --- Webhook signature verification (Standard Webhooks) ---

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Lenient base64/base64url → bytes: normalise url chars, drop anything outside
 * the alphabet, pad, then decode. Mirrors the tolerant decode the Standard
 * Webhooks libraries use, so a `polar_whs_…` secret decodes the same way Polar
 * signs (strict `atob` would throw on the url chars).
 */
function lenientBase64ToBytes(s: string): Uint8Array<ArrayBuffer> {
	let t = s
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.replace(/[^A-Za-z0-9+/]/g, '');
	while (t.length % 4 !== 0) t += '=';
	return base64ToBytes(t);
}

function utf8ToBytes(s: string): Uint8Array<ArrayBuffer> {
	const enc = new TextEncoder().encode(s);
	const out = new Uint8Array(enc.length);
	out.set(enc);
	return out;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

/** Constant-time-ish string compare (avoids early-exit timing leaks). */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Candidate HMAC keys for a Standard-Webhooks-style secret. Polar's secret is
 * `polar_whs_…` (not the canonical `whsec_<base64>`), and providers differ on
 * whether the HMAC key is the base64-decoded secret, the de-prefixed part, or
 * the raw UTF-8 bytes. We try all plausible derivations and accept if any
 * matches — an attacker still can't forge a signature without the secret.
 */
function candidateKeyBytes(secret: string): Uint8Array<ArrayBuffer>[] {
	const deprefixed = secret.replace(/^(whsec_|polar_whs_)/, '');
	const out: Uint8Array<ArrayBuffer>[] = [];
	const add = (fn: () => Uint8Array<ArrayBuffer>) => {
		try {
			const b = fn();
			if (b.length > 0) out.push(b);
		} catch {
			/* skip derivations that fail to decode */
		}
	};
	add(() => lenientBase64ToBytes(secret));
	add(() => lenientBase64ToBytes(deprefixed));
	add(() => utf8ToBytes(secret));
	add(() => utf8ToBytes(deprefixed));
	return out;
}

/** Default replay-protection window for `webhook-timestamp` (Standard Webhooks). */
const WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 5 * 60;

export interface VerifyPolarWebhookOptions {
	/** Current time in ms (tests). Defaults to `Date.now()`. */
	now?: number;
	/**
	 * Allowed clock skew, in seconds, between `webhook-timestamp` and now.
	 * Defaults to 5 minutes. Deliveries outside the window are rejected as
	 * potential replays (ADA-455).
	 */
	toleranceSec?: number;
}

/**
 * Verify a Polar webhook using the Standard Webhooks scheme.
 *
 * Headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`. Signed
 * content is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256, base64, compared
 * against each `v1,<sig>` entry in the header. Tries every plausible key
 * derivation for the secret. NEVER throws — returns `false` on any missing
 * header, decode error, or mismatch, so the caller maps `false` → 400.
 *
 * Replay protection (ADA-455): the `webhook-timestamp` must be within
 * `toleranceSec` (default 5min) of now, so a captured-but-old signed delivery
 * can't be replayed long after the fact.
 */
export async function verifyPolarWebhook(
	rawBody: string,
	headers: Headers,
	secret: string,
	options: VerifyPolarWebhookOptions = {},
): Promise<boolean> {
	try {
		const id = headers.get('webhook-id');
		const timestamp = headers.get('webhook-timestamp');
		const signatureHeader = headers.get('webhook-signature');
		if (!id || !timestamp || !signatureHeader) return false;

		// Timestamp freshness (ADA-455). Reject non-numeric or stale/future
		// timestamps before doing any HMAC work.
		const tsSec = Number(timestamp);
		if (!Number.isFinite(tsSec)) return false;
		const nowSec = (options.now ?? Date.now()) / 1000;
		const tolerance = options.toleranceSec ?? WEBHOOK_TIMESTAMP_TOLERANCE_SEC;
		if (Math.abs(nowSec - tsSec) > tolerance) return false;

		const signedContent = utf8ToBytes(`${id}.${timestamp}.${rawBody}`);
		const provided = signatureHeader.split(' ').map((entry) => {
			const comma = entry.indexOf(',');
			return comma === -1 ? entry : entry.slice(comma + 1);
		});

		for (const keyBytes of candidateKeyBytes(secret)) {
			const key = await crypto.subtle.importKey(
				'raw',
				keyBytes,
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['sign'],
			);
			const sigBuffer = await crypto.subtle.sign('HMAC', key, signedContent);
			const expected = bytesToBase64(new Uint8Array(sigBuffer));
			if (provided.some((sig) => safeEqual(sig, expected))) return true;
		}
		return false;
	} catch {
		return false;
	}
}
