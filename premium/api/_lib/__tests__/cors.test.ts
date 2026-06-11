/**
 * CORS allowlist policy (ADA-297): allowlisted Origin is reflected exactly,
 * anything else gets no Access-Control-Allow-Origin.
 */

import { describe, expect, it } from 'vitest';
import { corsHeaders } from '../cors';

describe('corsHeaders (ADA-297)', () => {
	it('reflects an allowlisted origin exactly', () => {
		const h = corsHeaders('https://hoursmith.io', {});
		expect(h['access-control-allow-origin']).toBe('https://hoursmith.io');
		expect(h.vary).toBe('Origin');
	});

	it('reflects localhost dev origins', () => {
		expect(
			corsHeaders('http://localhost:5173', {})['access-control-allow-origin'],
		).toBe('http://localhost:5173');
	});

	it('omits Access-Control-Allow-Origin for a disallowed origin', () => {
		const h = corsHeaders('https://evil.example.com', {});
		expect(h['access-control-allow-origin']).toBeUndefined();
		// Still emits the rest of the CORS headers + Vary.
		expect(h['access-control-allow-methods']).toContain('GET');
		expect(h.vary).toBe('Origin');
	});

	it('omits Access-Control-Allow-Origin when there is no Origin header', () => {
		expect(
			corsHeaders(null, {})['access-control-allow-origin'],
		).toBeUndefined();
	});

	it('never emits a wildcard origin', () => {
		for (const o of [
			'https://hoursmith.io',
			'https://evil.example.com',
			null,
		]) {
			expect(corsHeaders(o, {})['access-control-allow-origin']).not.toBe('*');
		}
	});

	it('allows the deployment origin via APP_URL', () => {
		const h = corsHeaders('https://my-preview.vercel.app', {
			APP_URL: 'https://my-preview.vercel.app/',
		});
		expect(h['access-control-allow-origin']).toBe(
			'https://my-preview.vercel.app',
		);
	});
});
