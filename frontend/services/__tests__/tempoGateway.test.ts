import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bridge from '../proxyUrlBridge';
import { buildTempoRequest, getTempoGatewayMode } from '../tempoGateway';

afterEach(() => vi.restoreAllMocks());

function stubBridge(
	state: Partial<ReturnType<typeof bridge.getProxyOverrideState>>,
) {
	vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
		hostedProxyUrl: null,
		userOverride: false,
		supabaseAccessToken: null,
		...state,
	});
}

describe('getTempoGatewayMode', () => {
	it('hosted when a hosted proxy is set and not overridden', () => {
		stubBridge({ hostedProxyUrl: 'https://app.example.com/api/proxy' });
		expect(getTempoGatewayMode('')).toBe('hosted');
	});
	it('self-hosted when a user proxy is set', () => {
		stubBridge({});
		expect(getTempoGatewayMode('https://proxy.me')).toBe('self-hosted');
	});
	it('direct when nothing is configured', () => {
		stubBridge({});
		expect(getTempoGatewayMode('')).toBe('direct');
	});
});

describe('buildTempoRequest', () => {
	it('hosted: token in X-Tempo-Token header, never in URL', () => {
		stubBridge({
			hostedProxyUrl: 'https://app.example.com/api/proxy',
			supabaseAccessToken: 'jwt',
		});
		const { url, headers } = buildTempoRequest(
			'secret',
			'',
			'worklogs/user/acc-1',
			new URLSearchParams({ from: '2026-06-01' }),
		);
		expect(url).toBe(
			'https://app.example.com/api/tempo?path=worklogs%2Fuser%2Facc-1&from=2026-06-01',
		);
		expect(headers['x-tempo-token']).toBe('secret');
		expect(headers.authorization).toBe('Bearer jwt');
		expect(url).not.toContain('secret');
	});
	it('self-hosted: token in Authorization, upstream URL proxied', () => {
		stubBridge({});
		const { url, headers } = buildTempoRequest(
			'secret',
			'https://proxy.me/',
			'worklogs',
			new URLSearchParams({ from: '2026-06-01' }),
		);
		expect(url).toBe(
			'https://proxy.me/https://api.tempo.io/4/worklogs?from=2026-06-01',
		);
		expect(headers.authorization).toBe('Bearer secret');
	});
	it('direct: hits api.tempo.io with bearer token', () => {
		stubBridge({});
		const { url } = buildTempoRequest(
			'secret',
			'',
			'worklogs',
			new URLSearchParams(),
		);
		expect(url).toBe('https://api.tempo.io/4/worklogs');
	});
});
