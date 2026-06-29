/**
 * The "use my own proxy instead of the hosted one" escape hatch must survive a
 * page reload. Before this was fixed, `userOverride` lived only in module-scope
 * memory, so every reload reset it to `false` and `bootstrapFromPersistedSession`
 * snapped a subscribed user straight back onto the hosted proxy — re-breaking the
 * app on every refresh for anyone whose Jira the hosted proxy can't serve.
 *
 * A "reload" is simulated by `vi.resetModules()` + a fresh dynamic import:
 * `localStorage` survives, the module re-evaluates from scratch — exactly what a
 * browser refresh does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_PROXY = 'http://localhost:8081';

async function loadBridge() {
	return import('../proxyUrlBridge');
}

/** Seed a persisted Supabase session so the bridge bootstraps a hosted URL. */
function seedSupabaseSession() {
	window.localStorage.setItem(
		'sb-test-auth-token',
		JSON.stringify({ access_token: 'jwt-token-123' }),
	);
}

describe('proxyUrlBridge — override persistence', () => {
	beforeEach(() => {
		window.localStorage.clear();
		vi.resetModules();
	});

	afterEach(() => {
		window.localStorage.clear();
		vi.resetModules();
	});

	it('persists the user override across a reload', async () => {
		const before = await loadBridge();
		before.setUserOverride(true);

		// Simulate a page reload: storage survives, module re-evaluates.
		vi.resetModules();
		const after = await loadBridge();

		expect(after.getProxyOverrideState().userOverride).toBe(true);
	});

	it('keeps a subscribed user on their own proxy after reload', async () => {
		seedSupabaseSession();

		const before = await loadBridge();
		before.setUserOverride(true);

		vi.resetModules();
		const after = await loadBridge();

		// The hosted URL is bootstrapped from the persisted session...
		expect(after.getProxyOverrideState().hostedProxyUrl).not.toBeNull();
		// ...but the persisted override means the user's own proxy still wins.
		expect(after.resolveProxyUrl(USER_PROXY)).toBe(USER_PROXY);
	});

	it('clears the persisted override when the user switches back to hosted', async () => {
		seedSupabaseSession();

		const before = await loadBridge();
		before.setUserOverride(true);
		before.setUserOverride(false);

		vi.resetModules();
		const after = await loadBridge();

		expect(after.getProxyOverrideState().userOverride).toBe(false);
		// Back on the hosted proxy after reload.
		expect(after.resolveProxyUrl(USER_PROXY)).not.toBe(USER_PROXY);
	});
});
