/**
 * Tests for the frontend flags transport (ADA-341).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLAGS, fetchFlags } from '../flagsService';

afterEach(() => {
	vi.restoreAllMocks();
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
