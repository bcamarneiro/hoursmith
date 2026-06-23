import { afterEach, describe, expect, it } from 'vitest';
import {
	__resetProxyBridgeForTests,
	setHostedProxyUrl,
	setSupabaseAccessToken,
	setUserOverride,
} from '../proxyUrlBridge';
import {
	buildRescueTimeRequest,
	getRescueTimeGatewayMode,
} from '../rescueTimeGateway';

const RT_URL = 'https://www.rescuetime.com/anapi/data';

function dataParams() {
	return new URLSearchParams({
		perspective: 'interval',
		restrict_kind: 'activity',
		resolution_time: 'day',
		restrict_begin: '2026-06-15',
		restrict_end: '2026-06-21',
		format: 'json',
	});
}

describe('rescueTimeGateway', () => {
	afterEach(() => {
		__resetProxyBridgeForTests();
	});

	describe('getRescueTimeGatewayMode', () => {
		it('is hosted when the bridge has a hosted proxy and no user override', () => {
			setHostedProxyUrl('https://hoursmith.io/api/proxy');
			expect(getRescueTimeGatewayMode('')).toBe('hosted');
			// A user-configured proxy is irrelevant once entitled.
			expect(getRescueTimeGatewayMode('http://localhost:8081')).toBe('hosted');
		});

		it('falls back to self-hosted when the user overrides the hosted proxy', () => {
			setHostedProxyUrl('https://hoursmith.io/api/proxy');
			setUserOverride(true);
			expect(getRescueTimeGatewayMode('http://localhost:8081')).toBe(
				'self-hosted',
			);
		});

		it('is self-hosted with a user proxy and no entitlement', () => {
			expect(getRescueTimeGatewayMode('http://localhost:8081')).toBe(
				'self-hosted',
			);
		});

		it('is direct with neither entitlement nor a user proxy', () => {
			expect(getRescueTimeGatewayMode('')).toBe('direct');
			expect(getRescueTimeGatewayMode('   ')).toBe('direct');
		});
	});

	describe('buildRescueTimeRequest', () => {
		it('hosted: targets /api/rescuetime, key + JWT in headers, never the URL', () => {
			setHostedProxyUrl('https://hoursmith.io/api/proxy');
			setSupabaseAccessToken('jwt-123');

			const { url, headers } = buildRescueTimeRequest(
				'rt-secret',
				'',
				dataParams(),
			);

			expect(url.startsWith('https://hoursmith.io/api/rescuetime?')).toBe(true);
			expect(url).not.toContain('rt-secret');
			expect(url).not.toContain('rescuetime.com');
			// Forwarded query params survive.
			expect(url).toContain('restrict_begin=2026-06-15');
			expect(headers['x-rescuetime-key']).toBe('rt-secret');
			expect(headers.authorization).toBe('Bearer jwt-123');
		});

		it('hosted: omits the Authorization header when no token is available', () => {
			setHostedProxyUrl('https://hoursmith.io/api/proxy');
			const { headers } = buildRescueTimeRequest('rt-secret', '', dataParams());
			expect(headers['x-rescuetime-key']).toBe('rt-secret');
			expect(headers.authorization).toBeUndefined();
		});

		it('self-hosted: prefixes the user proxy and puts the key in the query', () => {
			const { url, headers } = buildRescueTimeRequest(
				'rt-secret',
				'http://localhost:8081/',
				dataParams(),
			);
			expect(url).toBe(
				`http://localhost:8081/${RT_URL}?${(() => {
					const p = dataParams();
					p.set('key', 'rt-secret');
					return p.toString();
				})()}`,
			);
			expect(headers).toEqual({});
		});

		it('direct: hits rescuetime.com with the key in the query and no headers', () => {
			const { url, headers } = buildRescueTimeRequest(
				'rt-secret',
				'',
				dataParams(),
			);
			expect(url.startsWith(`${RT_URL}?`)).toBe(true);
			expect(url).toContain('key=rt-secret');
			expect(headers).toEqual({});
		});

		it('does not mutate the caller-supplied params (no key leaks back)', () => {
			const params = dataParams();
			buildRescueTimeRequest('rt-secret', 'http://localhost:8081', params);
			expect(params.has('key')).toBe(false);
		});
	});
});
