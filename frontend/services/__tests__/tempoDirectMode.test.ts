import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bridge from '../proxyUrlBridge';
import { buildTempoRequest, describeTempoNetworkError } from '../tempoGateway';

afterEach(() => vi.restoreAllMocks());

function noHostedProxy() {
	vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
		hostedProxyUrl: null,
		userOverride: false,
		supabaseAccessToken: null,
	});
}

/**
 * `api.tempo.io` sends no CORS headers, so a browser can only reach it through
 * a proxy. With neither a hosted relay nor a user CORS proxy configured, the
 * request cannot possibly succeed — the browser kills it before Tempo sees it.
 *
 * Returning a raw api.tempo.io URL in that case produces a generic network
 * error that points at the wrong cause: users read "couldn't reach Tempo" and
 * go check their token, which is fine. The gateway already documents that
 * callers "check the mode first and fail fast"; nothing did.
 */
describe('buildTempoRequest — direct mode', () => {
	it('still builds a URL, so offline/dev mode can intercept it', () => {
		// A service worker intercepts before the network there, so refusing
		// outright would make the Tempo path untestable.
		noHostedProxy();
		const { url } = buildTempoRequest('tok', '', 'worklogs');
		expect(url).toBe('https://api.tempo.io/4/worklogs');
	});

	it('explains a direct-mode failure as a missing proxy', () => {
		noHostedProxy();
		expect(describeTempoNetworkError('', 'Network request failed')).toMatch(
			/CORS proxy/i,
		);
	});

	it('leaves the original message alone when a proxy is configured', () => {
		noHostedProxy();
		const generic = 'Network request failed';
		expect(describeTempoNetworkError('https://proxy.example', generic)).toBe(
			generic,
		);
	});

	it('still builds a URL when a user proxy is configured', () => {
		noHostedProxy();
		const { url } = buildTempoRequest(
			'tok',
			'https://proxy.example',
			'worklogs',
		);
		expect(url).toBe('https://proxy.example/https://api.tempo.io/4/worklogs');
	});

	it('still builds a URL in hosted mode', () => {
		vi.spyOn(bridge, 'getProxyOverrideState').mockReturnValue({
			hostedProxyUrl: 'https://app.example/api/proxy',
			userOverride: false,
			supabaseAccessToken: 'jwt',
		});
		const { url, headers } = buildTempoRequest('tok', '', 'worklogs');
		expect(url).toContain('/api/tempo');
		expect(headers['x-tempo-token']).toBe('tok');
	});
});
