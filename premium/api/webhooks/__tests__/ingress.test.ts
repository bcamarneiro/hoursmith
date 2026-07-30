/**
 * Unit tests for the generic webhook ingress endpoint (ADA-642).
 *
 * The ingress endpoint handles method guard, provider resolution,
 * signature verification, JSON parsing, and optional handler dispatch.
 * Signature verification is tested end-to-end using real HMAC signatures
 * via Node's crypto module.
 *
 * When a handler is registered via `deps.handlers`, the endpoint delegates
 * to it. When no handler is registered, it still acks with 200 so the
 * provider doesn't retry.
 */

import { describe, expect, it, vi } from 'vitest';
import { handleWebhookIngress } from '../index.js';
import type { WebhookHandler, WebhookEvent } from '../index.js';
import { createHmac } from 'node:crypto';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a signed webhook request.
 * Uses a fresh timestamp so replay protection doesn't reject it.
 */
async function signedRequest(
	rawBody: string,
	provider: string,
	secret: string,
	overrides: {
		method?: string;
		path?: string;
		headers?: Record<string, string>;
	} = {},
): Promise<Request> {
	const id = 'evt_test';
	const ts = String(Math.floor(Date.now() / 1000));
	const signed = `${id}.${ts}.${rawBody}`;
	const hmac = createHmac('sha256', secret);
	hmac.update(signed);
	const sig = `v1,${hmac.digest('base64')}`;

	const h: Record<string, string> = {
		'x-webhook-provider': provider,
		'webhook-id': id,
		'webhook-timestamp': ts,
		'webhook-signature': sig,
		'content-type': 'application/json',
		...overrides.headers,
	};

	const url = overrides.path ?? 'https://hoursmith.io/api/webhooks';
	return new Request(url, {
		method: overrides.method ?? 'POST',
		headers: h,
		body: rawBody,
	});
}

const POLAR_SECRET = 'whsec_polar_test';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handleWebhookIngress', () => {
	it('returns 405 for non-POST requests', async () => {
		const req = new Request('https://hoursmith.io/api/webhooks', {
			method: 'GET',
		});
		const res = await handleWebhookIngress(req, {});
		expect(res.status).toBe(405);
		expect(await res.json()).toEqual({ error: 'method_not_allowed' });
	});

	it('returns 400 for an unknown provider', async () => {
		const body = '{"type":"test"}';
		const req = await signedRequest(body, 'unknown_provider', 'whsec_x', {
			headers: { 'x-webhook-provider': 'nonexistent' },
		});
		const res = await handleWebhookIngress(req, {
			env: {},
			secrets: { nonexistent: 'whsec_x' },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'unknown_provider' });
	});

	it('returns 500 when the webhook secret env var is missing', async () => {
		const body = '{"type":"test"}';
		const req = await signedRequest(body, 'polar', 'whsec_irrelevant', {
			path: 'https://hoursmith.io/api/webhooks/polar',
		});
		// No polar secret in either secrets or env — should 500.
		const res = await handleWebhookIngress(req, {
			secrets: {},
			env: {}, // no POLAR_WEBHOOK_SECRET
		});
		expect(res.status).toBe(500);
		const j = await res.json();
		expect(j.error).toBe('internal_error');
	});

	it('returns 400 for an invalid signature', async () => {
		const req = new Request('https://hoursmith.io/api/webhooks', {
			method: 'POST',
			headers: {
				'x-webhook-provider': 'polar',
				'webhook-id': 'evt_test',
				'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
				'webhook-signature': 'v1,badsig',
				'content-type': 'application/json',
			},
			body: '{"type":"test"}',
		});
		const res = await handleWebhookIngress(req, {
			secrets: { polar: POLAR_SECRET },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_signature' });
	});

	it('returns 400 for malformed JSON body', async () => {
		const req = await signedRequest('not json', 'polar', POLAR_SECRET);
		const res = await handleWebhookIngress(req, {
			secrets: { polar: POLAR_SECRET },
		});
		expect(res.status).toBe(400);
		const j = await res.json();
		expect(j.error).toBe('invalid_payload');
	});

	it('returns 200 when everything is valid and acks the delivery', async () => {
		const body = JSON.stringify({ type: 'order.created', data: {} });
		const req = await signedRequest(body, 'polar', POLAR_SECRET);
		const res = await handleWebhookIngress(req, {
			secrets: { polar: POLAR_SECRET },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true });
	});

	it('resolves the provider from the x-webhook-provider header', async () => {
		const body = JSON.stringify({ type: 'test', data: {} });
		const req = await signedRequest(body, 'polar', POLAR_SECRET);
		const res = await handleWebhookIngress(req, {
			secrets: { polar: POLAR_SECRET },
		});
		expect(res.status).toBe(200);
	});

	it('resolves the provider from the URL path', async () => {
		const body = JSON.stringify({ type: 'test', data: {} });
		const req = await signedRequest(body, 'polar', POLAR_SECRET, {
			path: 'https://hoursmith.io/api/webhooks/polar',
		});
		// Remove the header provider to test path-based routing
		const h = new Headers(req.headers);
		h.delete('x-webhook-provider');
		const pathReq = new Request(req, { headers: h });

		const res = await handleWebhookIngress(pathReq, {
			secrets: { polar: POLAR_SECRET },
		});
		expect(res.status).toBe(200);
	});

	it('routes to a registered handler via deps.handlers', async () => {
		const handler: WebhookHandler = vi.fn().mockResolvedValue(undefined);
		const body = JSON.stringify({ type: 'order.created', data: { id: 42 } });
		const req = await signedRequest(body, 'polar', POLAR_SECRET);
		const res = await handleWebhookIngress(req, {
			secrets: { polar: POLAR_SECRET },
			handlers: { polar: handler },
		});
		expect(res.status).toBe(200);
		expect(handler).toHaveBeenCalledTimes(1);
		const eventArg = (handler as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as WebhookEvent;
		expect(eventArg.type).toBe('order.created');
		expect(eventArg.data).toEqual({ id: 42 });
		expect(eventArg.provider).toBe('polar');
	});

	it('returns the handler response when it returns a Response', async () => {
		const handler: WebhookHandler = vi
			.fn()
			.mockResolvedValue(new Response('custom', { status: 201 }));
		const body = JSON.stringify({ type: 'test', data: {} });
		const req = await signedRequest(body, 'polar', POLAR_SECRET);
		const res = await handleWebhookIngress(req, {
			secrets: { polar: POLAR_SECRET },
			handlers: { polar: handler },
		});
		expect(res.status).toBe(201);
		expect(await res.text()).toBe('custom');
	});

	it('returns 500 when the handler throws', async () => {
		const handler: WebhookHandler = vi
			.fn()
			.mockRejectedValue(new Error('boom'));
		const body = JSON.stringify({ type: 'test', data: {} });
		const req = await signedRequest(body, 'polar', POLAR_SECRET);
		const res = await handleWebhookIngress(req, {
			secrets: { polar: POLAR_SECRET },
			handlers: { polar: handler },
		});
		expect(res.status).toBe(500);
		const j = await res.json();
		expect(j.error).toBe('internal_error');
	});

	it('acks even when no handler is registered (no retry)', async () => {
		const body = JSON.stringify({ type: 'test', data: {} });
		const req = await signedRequest(body, 'polar', POLAR_SECRET);
		const res = await handleWebhookIngress(req, {
			secrets: { polar: POLAR_SECRET },
			handlers: {}, // no handler for polar
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true });
	});
});
