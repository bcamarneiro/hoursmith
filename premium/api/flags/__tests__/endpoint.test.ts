/**
 * Tests for GET and PATCH /api/flags (ADA-341, ADA-620).
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

const ADMIN_EMAILS = 'admin@hoursmith.io';

function req(method: string, token?: string): Request {
	return new Request('https://hoursmith.io/api/flags', {
		method,
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
}

function patchReq(body: unknown, token = 'admin-tok'): Request {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		authorization: `Bearer ${token}`,
	};
	return new Request('https://hoursmith.io/api/flags', {
		method: 'PATCH',
		headers,
		body: JSON.stringify(body),
	});
}

/** Returns a verifyJwt mock that resolves to a known admin. */
function adminVerify(): ReturnType<typeof vi.fn> {
	return vi.fn(async () => ({
		userId: 'admin-1',
		email: 'admin@hoursmith.io',
	}));
}

/** Returns a verifyJwt mock that resolves successfully but is NOT an admin. */
function nonAdminVerify(): ReturnType<typeof vi.fn> {
	return vi.fn(async () => ({
		userId: 'user-1',
		email: 'user@example.com',
	}));
}

/** Returns a verifyJwt mock that fails (invalid token). */
function failingVerify(): ReturnType<typeof vi.fn> {
	return vi.fn(async () => null);
}

/** Always-true writeEdgeConfig mock. */
function successfulWrites(): ReturnType<typeof vi.fn> {
	return vi.fn(async () => true);
}

/** Always-false writeEdgeConfig mock (simulates store failure). */
function failingWrites(): ReturnType<typeof vi.fn> {
	return vi.fn(async () => false);
}

describe('GET /api/flags', () => {
	it('returns 405 on a non-GET, non-PATCH method', async () => {
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

describe('PATCH /api/flags', () => {
	it('returns 401 when no authorization header is present', async () => {
		const res = await handleFlags(
			new Request('https://hoursmith.io/api/flags', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ maintenance_mode: true }),
			}),
			{
				resolveFlags: vi.fn(),
				verifyJwt: failingVerify(),
				writeEdgeConfig: successfulWrites(),
				adminEmails: ADMIN_EMAILS,
			},
		);
		expect(res.status).toBe(401);
		await expect(res.json()).resolves.toMatchObject({ error: 'unauthorized' });
	});

	it('returns 401 when the bearer token is invalid', async () => {
		const res = await handleFlags(patchReq({ maintenance_mode: true }, 'bad'), {
			resolveFlags: vi.fn(),
			verifyJwt: failingVerify(),
			writeEdgeConfig: successfulWrites(),
			adminEmails: ADMIN_EMAILS,
		});
		expect(res.status).toBe(401);
		await expect(res.json()).resolves.toMatchObject({ error: 'unauthorized' });
	});

	it('returns 403 when the caller is not an admin', async () => {
		const res = await handleFlags(patchReq({ maintenance_mode: true }), {
			resolveFlags: vi.fn(),
			verifyJwt: nonAdminVerify(),
			writeEdgeConfig: successfulWrites(),
			adminEmails: ADMIN_EMAILS,
		});
		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toMatchObject({ error: 'forbidden' });
	});

	it('returns 400 for invalid JSON body', async () => {
		const res = await handleFlags(
			new Request('https://hoursmith.io/api/flags', {
				method: 'PATCH',
				headers: {
					'content-type': 'application/json',
					authorization: 'Bearer admin-tok',
				},
				body: 'not-json',
			}),
			{
				resolveFlags: vi.fn(),
				verifyJwt: adminVerify(),
				writeEdgeConfig: successfulWrites(),
				adminEmails: ADMIN_EMAILS,
			},
		);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({ error: 'invalid_json' });
	});

	it('returns 400 when the body is empty (no flags)', async () => {
		const res = await handleFlags(patchReq({}), {
			resolveFlags: vi.fn(),
			verifyJwt: adminVerify(),
			writeEdgeConfig: successfulWrites(),
			adminEmails: ADMIN_EMAILS,
		});
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			error: 'no_flags_provided',
		});
	});

	it('returns 400 for unknown flag keys', async () => {
		const res = await handleFlags(patchReq({ unknown_flag: true }), {
			resolveFlags: vi.fn(),
			verifyJwt: adminVerify(),
			writeEdgeConfig: successfulWrites(),
			adminEmails: ADMIN_EMAILS,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string; unknown?: string[] };
		expect(body.error).toBe('unknown_flags');
		expect(body.unknown).toEqual(['unknown_flag']);
	});

	it('returns 200 and writes a single flag', async () => {
		const resolveFlags = vi.fn(async () => ({
			...SNAPSHOT,
			maintenanceMode: true,
		}));
		const writeFn = successfulWrites();
		const res = await handleFlags(patchReq({ maintenance_mode: true }), {
			resolveFlags,
			verifyJwt: adminVerify(),
			writeEdgeConfig: writeFn,
			adminEmails: ADMIN_EMAILS,
		});
		expect(res.status).toBe(200);
		expect(writeFn).toHaveBeenCalledWith('maintenance_mode', true);
		await expect(res.json()).resolves.toMatchObject({ maintenanceMode: true });
	});

	it('returns 200 and writes multiple flags', async () => {
		const resolveFlags = vi.fn(async () => ({
			...SNAPSHOT,
			maintenanceMode: true,
			checkoutEnabled: false,
		}));
		const writeFn = successfulWrites();
		const res = await handleFlags(
			patchReq({ maintenance_mode: true, paywall_public: true }),
			{
				resolveFlags,
				verifyJwt: adminVerify(),
				writeEdgeConfig: writeFn,
				adminEmails: ADMIN_EMAILS,
			},
		);
		expect(res.status).toBe(200);
		expect(writeFn).toHaveBeenCalledWith('maintenance_mode', true);
		expect(writeFn).toHaveBeenCalledWith('paywall_public', true);
	});

	it('returns 502 when any flag write fails', async () => {
		const writeFn = failingWrites();
		const res = await handleFlags(patchReq({ maintenance_mode: true }), {
			resolveFlags: vi.fn(),
			verifyJwt: adminVerify(),
			writeEdgeConfig: writeFn,
			adminEmails: ADMIN_EMAILS,
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string; failed?: string[] };
		expect(body.error).toBe('write_failed');
		expect(body.failed).toContain('maintenance_mode');
	});
});
