/**
 * Tests for the operational kill-switch flags (ADA-341).
 *
 * Covers the resolution precedence (Edge Config > env var > default) and the
 * paywall allowlist / canCheckout logic. The Edge Config reader is mocked at the
 * module boundary so the env-var and default tiers are exercised
 * deterministically without any network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readEdgeConfigMock = vi.fn();
vi.mock('../edgeConfig.js', () => ({
	readEdgeConfig: (key: string) => readEdgeConfigMock(key),
}));

import {
	canCheckout,
	checkoutEnabled,
	isAllowlisted,
	maintenanceMode,
	paywallPublic,
	resolveFlags,
	writeFlags,
} from '../flags.js';

beforeEach(() => {
	// Default: Edge Config misses for every key (falls through to env/default).
	readEdgeConfigMock.mockReset();
	readEdgeConfigMock.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.clearAllMocks();
});

function withEdge(values: Record<string, unknown>): void {
	readEdgeConfigMock.mockImplementation(async (key: string) => values[key]);
}

describe('flag resolution precedence', () => {
	it('uses hardcoded defaults when edge config and env are absent', async () => {
		expect(await paywallPublic({})).toBe(false);
		expect(await checkoutEnabled({})).toBe(true);
		expect(await maintenanceMode({})).toBe(false);
	});

	it('falls back to the env var when edge config is absent', async () => {
		expect(await paywallPublic({ PAYWALL_PUBLIC: 'open' })).toBe(true);
		expect(await paywallPublic({ PAYWALL_PUBLIC: 'closed' })).toBe(false);
	});

	it('edge config overrides the env var and default', async () => {
		withEdge({ paywall_public: true });
		expect(await paywallPublic({ PAYWALL_PUBLIC: 'closed' })).toBe(true);
	});

	it('edge config can disable checkout (no env fallback)', async () => {
		withEdge({ polar_checkout_enabled: false });
		expect(await checkoutEnabled({})).toBe(false);
	});

	it('maintenance flips on via edge config', async () => {
		withEdge({ maintenance_mode: true });
		expect(await maintenanceMode({})).toBe(true);
	});
});

describe('allowlist + canCheckout', () => {
	it('opens for everyone when the paywall is public', async () => {
		expect(await canCheckout(null, { PAYWALL_PUBLIC: 'open' })).toBe(true);
	});

	it('honors the email allowlist when the paywall is closed', async () => {
		const env = {
			PAYWALL_PUBLIC: 'closed',
			PAYWALL_ALLOW_EMAILS: 'bruno@futuresketches.com, other@x.com',
		};
		expect(await canCheckout('bruno@futuresketches.com', env)).toBe(true);
		expect(await canCheckout('BRUNO@futuresketches.com', env)).toBe(true);
		expect(await canCheckout('nope@x.com', env)).toBe(false);
		expect(await canCheckout(null, env)).toBe(false);
	});

	it('treats a wildcard allowlist as everyone', async () => {
		const env = { PAYWALL_PUBLIC: 'closed', PAYWALL_ALLOW_EMAILS: '*' };
		expect(await isAllowlisted('anyone@x.com', env)).toBe(true);
		expect(await canCheckout('anyone@x.com', env)).toBe(true);
	});

	it('lets an edge-config allowlist override the env var', async () => {
		withEdge({ paywall_public: false, paywall_allow_emails: ['a@b.com'] });
		expect(
			await isAllowlisted('a@b.com', { PAYWALL_ALLOW_EMAILS: 'z@z.com' }),
		).toBe(true);
		expect(
			await isAllowlisted('z@z.com', { PAYWALL_ALLOW_EMAILS: 'z@z.com' }),
		).toBe(false);
	});
});

describe('resolveFlags', () => {
	it('computes paywallOpenForMe per caller email', async () => {
		const env = { PAYWALL_PUBLIC: 'closed', PAYWALL_ALLOW_EMAILS: 'a@b.com' };
		const mine = await resolveFlags('a@b.com', env);
		expect(mine.paywallOpenForMe).toBe(true);
		expect(mine.checkoutEnabled).toBe(true);
		expect(mine.maintenanceMode).toBe(false);
		const other = await resolveFlags('z@z.com', env);
		expect(other.paywallOpenForMe).toBe(false);
	});
});

describe('writeFlags', () => {
	const ORIGINAL_ENV = process.env;

	beforeEach(() => {
		process.env = { ...ORIGINAL_ENV };
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 200 })),
		);
	});

	afterEach(() => {
		process.env = ORIGINAL_ENV;
		vi.unstubAllGlobals();
	});

	it('returns edge_config_not_configured when env vars are missing', async () => {
		delete process.env.VERCEL_API_TOKEN;
		delete process.env.EDGE_CONFIG;
		expect(await writeFlags({ maintenanceMode: true })).toBe(
			'edge_config_not_configured',
		);
	});

	it('returns edge_config_not_configured when only token is set', async () => {
		process.env.VERCEL_API_TOKEN = 'tok';
		delete process.env.EDGE_CONFIG;
		expect(await writeFlags({ maintenanceMode: true })).toBe(
			'edge_config_not_configured',
		);
	});

	it('sends an upsert PATCH to the Vercel API', async () => {
		process.env.VERCEL_API_TOKEN = 'tok_xxx';
		process.env.EDGE_CONFIG =
			'https://edge-config.vercel.com/ecfg_abc123';
		const fetchMock = vi.fn(async (_url: string, opts: RequestInit) => {
			const body = JSON.parse(opts.body as string);
			expect(body).toEqual({
				items: [
					{ operation: 'upsert', key: 'maintenance_mode', value: true },
				],
			});
			expect(opts.method).toBe('PATCH');
			expect((opts.headers as Record<string, string>).authorization).toBe(
				'Bearer tok_xxx',
			);
			return new Response(null, { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);
		expect(await writeFlags({ maintenanceMode: true })).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const calledUrl = fetchMock.mock.calls[0][0];
		expect(calledUrl).toContain('ecfg_abc123');
	});

	it('skips paywallOpenForMe (computed per-user, not stored)', async () => {
		process.env.VERCEL_API_TOKEN = 'tok';
		process.env.EDGE_CONFIG =
			'https://edge-config.vercel.com/ecfg_skip';
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		// Only paywallOpenForMe in the patch → no items → no fetch
		expect(
			await writeFlags({ paywallOpenForMe: false }),
		).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns error string when the Vercel API responds non-OK', async () => {
		process.env.VERCEL_API_TOKEN = 'tok';
		process.env.EDGE_CONFIG =
			'https://edge-config.vercel.com/ecfg_bad';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 403 })),
		);
		expect(await writeFlags({ maintenanceMode: true })).toBe(
			'edge_config_write_failed: 403',
		);
	});

	it('handles fetch throwing a network error', async () => {
		process.env.VERCEL_API_TOKEN = 'tok';
		process.env.EDGE_CONFIG =
			'https://edge-config.vercel.com/ecfg_net';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('getaddrinfo ENOTFOUND');
			}),
		);
		const result = await writeFlags({ maintenanceMode: true });
		expect(result).toMatch(/^edge_config_write_error:/);
	});

	it('maps multiple flags to their correct edge keys', async () => {
		process.env.VERCEL_API_TOKEN = 'tok';
		process.env.EDGE_CONFIG =
			'https://edge-config.vercel.com/ecfg_multi';
		const fetchMock = vi.fn(async (_url: string, opts: RequestInit) => {
			const body = JSON.parse(opts.body as string);
			expect(body.items).toEqual([
				{ operation: 'upsert', key: 'paywall_public', value: true },
				{
					operation: 'upsert',
					key: 'announcement_banner',
					value: 'Hi!',
				},
			]);
			return new Response(null, { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);
		expect(
			await writeFlags({
				paywallPublic: true,
				announcementBanner: 'Hi!',
			}),
		).toBeNull();
	});

	it('returns null for an empty patch (nothing to write)', async () => {
		process.env.VERCEL_API_TOKEN = 'tok';
		process.env.EDGE_CONFIG =
			'https://edge-config.vercel.com/ecfg_empty';
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		expect(await writeFlags({})).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
