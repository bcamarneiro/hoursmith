/**
 * Generic webhook ingress handler for Hoursmith Premium (ADA-642).
 *
 * A single endpoint (`POST /api/webhooks[/:provider]`) that receives webhooks
 * from multiple providers. Handles method guard, provider resolution (header
 * or URL path), Standard Webhooks signature verification (HMAC-SHA256), JSON
 * parsing, and optional handler dispatch.
 *
 * When a handler is registered via `deps.handlers[provider]`, the endpoint
 * delegates to it. When no handler is registered, it still acks with 200 so
 * the provider doesn't retry.
 *
 * Security model (Standard Webhooks):
 *   1. Read the RAW body — parsing first breaks HMAC verification.
 *   2. Verify `webhook-signature` against the provider's secret.
 *   3. Only then parse JSON and act.
 *
 * Linear: ADA-642.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WebhookEvent {
	type: string;
	data: Record<string, unknown>;
	provider: string;
}

export type WebhookHandler = (
	event: WebhookEvent,
) => Promise<Response | void>;

export interface IngressDeps {
	/** Injectable env for tests. Falls back to `process.env` when not set. */
	env?: Partial<Record<string, string | undefined>>;
	/** Provider → webhook secret. */
	secrets?: Record<string, string>;
	/** Provider → handler. */
	handlers?: Record<string, WebhookHandler>;
}

// ─── Known providers (allowlist) ─────────────────────────────────────────────

const KNOWN_PROVIDERS = new Set(['polar']);

// ─── Main handler ───────────────────────────────────────────────────────────

export async function handleWebhookIngress(
	request: Request,
	deps: IngressDeps = {},
): Promise<Response> {
	// Method guard — only POST is accepted.
	if (request.method !== 'POST') {
		return json(405, { error: 'method_not_allowed' });
	}

	// 1. Resolve the provider from header or URL path.
	const provider = resolveProvider(request);
	if (!provider || !KNOWN_PROVIDERS.has(provider)) {
		return json(400, { error: 'unknown_provider' });
	}

	// 2. Look up the webhook secret for this provider.
	const secrets = deps.secrets ?? {};
	const env = deps.env ?? {};
	const secret =
		secrets[provider] ??
		env[`${provider.toUpperCase()}_WEBHOOK_SECRET`];
	if (!secret) {
		return json(500, { error: 'internal_error' });
	}

	// 3. Read the RAW body (must be unparsed for HMAC verification).
	const rawBody = await request.text();

	// 4. Verify the Standard Webhooks signature.
	const valid = await verifySignature(rawBody, request.headers, secret);
	if (!valid) {
		return json(400, { error: 'invalid_signature' });
	}

	// 5. Parse the JSON payload.
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(rawBody) as Record<string, unknown>;
	} catch {
		return json(400, { error: 'invalid_payload' });
	}

	// 6. Build the typed event.
	const event: WebhookEvent = {
		type: (body.type as string) ?? 'unknown',
		data: (body.data as Record<string, unknown>) ?? {},
		provider,
	};

	// 7. Dispatch to the registered handler if one exists.
	const handlers = deps.handlers ?? {};
	const handler = handlers[provider];
	if (handler) {
		try {
			const result = await handler(event);
			if (result instanceof Response) {
				return result;
			}
		} catch {
			return json(500, { error: 'internal_error' });
		}
	}

	// 8. Ack — no handler is fine. 200 prevents the provider from retrying.
	return json(200, { received: true });
}

// ─── Provider resolution ────────────────────────────────────────────────────

/**
 * Resolve the webhook provider.
 *
 * Priority:
 *   1. `x-webhook-provider` header (primary).
 *   2. URL path segment after `/api/webhooks/` (fallback for path-based routing).
 */
function resolveProvider(request: Request): string | null {
	const header = request.headers.get('x-webhook-provider');
	if (header) return header;

	try {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/api\/webhooks\/([a-z0-9_-]+)$/i);
		if (match) return match[1];
	} catch {
		// Malformed URL — shouldn't happen in practice.
	}

	return null;
}

// ─── Signature verification ─────────────────────────────────────────────────

/**
 * Verify a Standard Webhooks signature (HMAC-SHA256).
 *
 * The signed content is `{webhook-id}.{webhook-timestamp}.{rawBody}`,
 * HMAC-SHA256 with the provider secret, base64-encoded. The signature header
 * carries `v1,{base64sig}`.
 *
 * Returns `false` on missing headers, decode errors, or mismatch.
 */
async function verifySignature(
	rawBody: string,
	headers: Headers,
	secret: string,
): Promise<boolean> {
	try {
		const sigHeader = headers.get('webhook-signature');
		const id = headers.get('webhook-id');
		const ts = headers.get('webhook-timestamp');

		if (!sigHeader || !id || !ts) return false;

		// Parse "v1,<base64 signature>"
		const comma = sigHeader.indexOf(',');
		if (comma === -1) return false;
		const providedSig = sigHeader.slice(comma + 1);

		// Compute the expected signature.
		const signed = `${id}.${ts}.${rawBody}`;
		const hmac = createHmac('sha256', secret);
		hmac.update(signed);
		const expected = hmac.digest('base64');

		// Constant-time comparison to avoid timing attacks.
		const a = Buffer.from(providedSig);
		const b = Buffer.from(expected);
		return a.length === b.length && timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function json(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
