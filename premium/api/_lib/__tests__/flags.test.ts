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
