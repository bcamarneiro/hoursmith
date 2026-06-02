/**
 * Tests for GET /api/flags (ADA-341).
 */

import { describe, expect, it, vi } from 'vitest';
import type { PublicFlags } from '../../_lib/flags.js';
import { handleFlags } from '../index.js';

const SNAPSHOT: PublicFlags = {
	maintenanceMode: false,
	checkoutEnabled: true,
	paywallPublic: false,
	paywallOpenForMe: false,
	announcementBanner: null,
};

function req(method: string, token?: string): Request {
	return new Request('https://hoursmith.io/api/flags', {
		method,
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
}

describe('GET /api/flags', () => {
	it('returns 405 on a non-GET method', async () => {
		const res = await handleFlags(req('POST'), {
			resolveFlags: vi.fn(),
			emailFromToken: vi.fn(),
		});
		expect(res.status).toBe(405);
	});

	it('returns the anonymous snapshot without resolving an email', async () => {
		const resolveFlags = vi.fn(async () => SNAPSHOT);
		const emailFromToken = vi.fn(async () => null);
		const res = await handleFlags(req('GET'), { resolveFlags, emailFromToken });
		expect(emailFromToken).not.toHaveBeenCalled();
		expect(resolveFlags).toHaveBeenCalledWith(null);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		await expect(res.json()).resolves.toMatchObject({ checkoutEnabled: true });
	});

	it('resolves the caller email when a bearer token is present', async () => {
		const resolveFlags = vi.fn(async () => ({
			...SNAPSHOT,
			paywallOpenForMe: true,
		}));
		const emailFromToken = vi.fn(async () => 'a@b.com');
		const res = await handleFlags(req('GET', 'tok'), {
			resolveFlags,
			emailFromToken,
		});
		expect(emailFromToken).toHaveBeenCalledWith('tok');
		expect(resolveFlags).toHaveBeenCalledWith('a@b.com');
		await expect(res.json()).resolves.toMatchObject({ paywallOpenForMe: true });
	});
});
