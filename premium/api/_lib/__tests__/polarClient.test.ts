import { describe, expect, it, vi } from 'vitest';
import {
	createPolarCheckout,
	defaultPolarConfig,
	verifyPolarWebhook,
} from '../polarClient.js';

// Canonical Standard Webhooks test vector (https://www.standardwebhooks.com).
// Proves our HMAC implementation matches the spec, not just itself.
const VECTOR = {
	secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
	id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
	timestamp: '1614265330',
	payload: '{"test": 2432232314}',
	signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

function vectorHeaders(overrides: Record<string, string> = {}): Headers {
	return new Headers({
		'webhook-id': VECTOR.id,
		'webhook-timestamp': VECTOR.timestamp,
		'webhook-signature': VECTOR.signature,
		...overrides,
	});
}

// Pin "now" to the vector's timestamp so the freshness window (ADA-455) does
// not reject this fixed historical test vector.
const NOW_AT_VECTOR = { now: Number(VECTOR.timestamp) * 1000 };

describe('verifyPolarWebhook', () => {
	it('accepts a valid Standard Webhooks signature', async () => {
		const ok = await verifyPolarWebhook(
			VECTOR.payload,
			vectorHeaders(),
			VECTOR.secret,
			NOW_AT_VECTOR,
		);
		expect(ok).toBe(true);
	});

	it('rejects a tampered body', async () => {
		const ok = await verifyPolarWebhook(
			'{"test": 9999999999}',
			vectorHeaders(),
			VECTOR.secret,
			NOW_AT_VECTOR,
		);
		expect(ok).toBe(false);
	});

	it('rejects a tampered signature', async () => {
		const ok = await verifyPolarWebhook(
			VECTOR.payload,
			vectorHeaders({
				'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			}),
			VECTOR.secret,
			NOW_AT_VECTOR,
		);
		expect(ok).toBe(false);
	});

	it('rejects when a required header is missing', async () => {
		const headers = vectorHeaders();
		headers.delete('webhook-signature');
		const ok = await verifyPolarWebhook(
			VECTOR.payload,
			headers,
			VECTOR.secret,
			NOW_AT_VECTOR,
		);
		expect(ok).toBe(false);
	});

	it('matches when the header carries multiple space-separated signatures', async () => {
		const ok = await verifyPolarWebhook(
			VECTOR.payload,
			vectorHeaders({
				'webhook-signature': `v1,wrongsig ${VECTOR.signature}`,
			}),
			VECTOR.secret,
			NOW_AT_VECTOR,
		);
		expect(ok).toBe(true);
	});

	// Regression: Polar's secret is `polar_whs_…` with base64url chars. Strict
	// atob() used to throw InvalidCharacterError → an uncaught 500 on every
	// delivery. Must now decode leniently and return false (never throw).
	it('does not throw on a polar_whs_ secret with url chars', async () => {
		const ok = await verifyPolarWebhook(
			VECTOR.payload,
			vectorHeaders({ 'webhook-signature': 'v1,not-the-real-signature' }),
			'polar_whs_u7ss4HAF-some_url-safe_chars',
			NOW_AT_VECTOR,
		);
		expect(ok).toBe(false);
	});

	// ADA-455: replay protection — a captured-but-stale signed delivery must be
	// rejected even though its signature is otherwise valid.
	it('rejects a stale timestamp outside the freshness window (ADA-455)', async () => {
		const ok = await verifyPolarWebhook(
			VECTOR.payload,
			vectorHeaders(),
			VECTOR.secret,
			// 10 minutes after the signed timestamp — beyond the 5min tolerance.
			{ now: (Number(VECTOR.timestamp) + 600) * 1000 },
		);
		expect(ok).toBe(false);
	});

	it('rejects a far-future timestamp outside the freshness window (ADA-455)', async () => {
		const ok = await verifyPolarWebhook(
			VECTOR.payload,
			vectorHeaders(),
			VECTOR.secret,
			{ now: (Number(VECTOR.timestamp) - 600) * 1000 },
		);
		expect(ok).toBe(false);
	});

	it('rejects a non-numeric timestamp (ADA-455)', async () => {
		const ok = await verifyPolarWebhook(
			VECTOR.payload,
			vectorHeaders({ 'webhook-timestamp': 'not-a-number' }),
			VECTOR.secret,
			NOW_AT_VECTOR,
		);
		expect(ok).toBe(false);
	});
});

describe('createPolarCheckout', () => {
	it('posts the confirmed payload shape and returns the hosted url', async () => {
		const fetchImpl = vi.fn(
			async (_input: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						id: 'co_123',
						url: 'https://polar.sh/checkout/co_123',
					}),
					{ status: 201, headers: { 'content-type': 'application/json' } },
				),
		);

		const result = await createPolarCheckout(
			{
				productId: 'prod_abc',
				customerExternalId: 'user-1',
				successUrl: 'https://hoursmith.io/account?upgrade=success',
			},
			{
				config: { baseUrl: 'https://api.polar.sh/v1', accessToken: 'tok' },
				fetchImpl,
			},
		);

		expect(result).toEqual({
			id: 'co_123',
			url: 'https://polar.sh/checkout/co_123',
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://api.polar.sh/v1/checkouts/');
		expect(init?.method).toBe('POST');
		const body = JSON.parse(init?.body as string);
		expect(body).toEqual({
			products: ['prod_abc'],
			customer_external_id: 'user-1',
			success_url: 'https://hoursmith.io/account?upgrade=success',
		});
	});

	it('throws when the response is missing url/id', async () => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify({}), { status: 201 }),
		);
		await expect(
			createPolarCheckout(
				{ productId: 'p', customerExternalId: 'u', successUrl: 's' },
				{ config: { baseUrl: 'https://x/v1', accessToken: 't' }, fetchImpl },
			),
		).rejects.toThrow(/missing url\/id/);
	});
});

describe('defaultPolarConfig', () => {
	it('defaults to the sandbox base url when POLAR_SERVER is unset', () => {
		const cfg = defaultPolarConfig({ POLAR_ACCESS_TOKEN: 'tok' });
		expect(cfg.baseUrl).toBe('https://sandbox-api.polar.sh/v1');
	});

	it('uses production base url only when explicitly set', () => {
		const cfg = defaultPolarConfig({
			POLAR_ACCESS_TOKEN: 'tok',
			POLAR_SERVER: 'production',
		});
		expect(cfg.baseUrl).toBe('https://api.polar.sh/v1');
	});

	it('throws when the access token is missing', () => {
		expect(() => defaultPolarConfig({})).toThrow(/POLAR_ACCESS_TOKEN/);
	});
});
