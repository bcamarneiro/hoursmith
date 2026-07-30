/**
 * Tests for the frontend flags transport (ADA-341).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLAGS, fetchFlags, updateFlags } from '../flagsService';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('updateFlags', () => {
	it('sends a PATCH with the partial body and returns the server snapshot', async () => {
		const serverResponse = { ...DEFAULT_FLAGS, maintenanceMode: true };
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, opts: RequestInit) => {
				expect(opts.method).toBe('PATCH');
				expect(opts.headers).toEqual({
					'content-type': 'application/json',
				});
				expect(JSON.parse(opts.body as string)).toEqual({
					maintenanceMode: true,
				});
				return new Response(JSON.stringify(serverResponse), {
					status: 200,
				});
			}),
		);
		const result = await updateFlags({ maintenanceMode: true });
		expect(result.maintenanceMode).toBe(true);
		expect(result.checkoutEnabled).toBe(true);
	});

	it('throws a ServiceError on a non-OK response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: 'nope' }), {
						status: 422,
					}),
			),
		);
		await expect(updateFlags({ checkoutEnabled: false })).rejects.toThrow(
			/flags/,
		);
	});

	it('throws a ServiceError on network failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			}),
		);
		await expect(
			updateFlags({ announcementBanner: 'hi' }),
		).rejects.toThrow(/flags/);
	});
});

describe('fetchFlags', () => {
	it('merges the server snapshot over the defaults', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ maintenanceMode: true }), {
						status: 200,
					}),
			),
		);
		const flags = await fetchFlags();
		expect(flags.maintenanceMode).toBe(true);
		// untouched fields keep their safe defaults
		expect(flags.checkoutEnabled).toBe(true);
		expect(flags.paywallOpenForMe).toBe(false);
	});

	it('sends the bearer token when provided', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		await fetchFlags('tok');
		expect(fetchMock).toHaveBeenCalledWith('/api/flags', {
			headers: { authorization: 'Bearer tok' },
		});
	});

	it('falls back to safe defaults on a non-OK response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 500 })),
		);
		expect(await fetchFlags()).toEqual(DEFAULT_FLAGS);
	});

	it('falls back to safe defaults when fetch throws', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network');
			}),
		);
		expect(await fetchFlags()).toEqual(DEFAULT_FLAGS);
	});
});
