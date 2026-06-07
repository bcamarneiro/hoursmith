/**
 * Product analytics via PostHog EU (ADA-377).
 *
 * Configured for the GDPR / Polar-MoR / local-first posture:
 *   - **EU cloud** host (data residency).
 *   - **Cookieless** (`persistence: 'memory'`) → no persistent identifiers, so
 *     no consent banner is required.
 *   - **No autocapture** and **no session recording** — the app renders client
 *     Jira worklog data (issue keys, client names); we never want that captured.
 *     We send only explicit funnel events + SPA pageviews (benign route paths).
 *
 * The client key is publishable and injected at build via `VITE_POSTHOG_KEY`
 * (see rspack.config.js DefinePlugin). When it's absent — free/self-host builds,
 * CI, local dev — every function here is a no-op and nothing is sent.
 *
 * posthog-js is **dynamically imported** so it lands in its own chunk: the
 * ~160 KB SDK never bloats the main bundle and is only fetched when a key is
 * configured. Events fired before the chunk resolves are buffered, then flushed.
 */

import type { PostHog } from 'posthog-js';

const KEY = process.env.VITE_POSTHOG_KEY || '';
const HOST = process.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com';

let instance: PostHog | null = null;
let pending: Array<[string, Record<string, unknown> | undefined]> = [];

export function initAnalytics(): void {
	if (!KEY || instance) return;
	void import('posthog-js').then(({ default: posthog }) => {
		posthog.init(KEY, {
			api_host: HOST,
			persistence: 'memory',
			autocapture: false,
			capture_pageview: false,
			disable_session_recording: true,
			person_profiles: 'identified_only',
		});
		instance = posthog;
		for (const [event, properties] of pending)
			posthog.capture(event, properties);
		pending = [];
	});
}

function capture(event: string, properties?: Record<string, unknown>): void {
	if (!KEY) return; // analytics disabled — drop silently
	if (instance) {
		instance.capture(event, properties);
	} else if (pending.length < 100) {
		// Buffer until the SDK chunk resolves (bounded so a failed load can't grow
		// unboundedly).
		pending.push([event, properties]);
	}
}

/**
 * Capture a SPA pageview. Call on route change. PostHog enriches the event with
 * the live `$current_url`; we also attach the in-app `path` for easy filtering.
 */
export function capturePageview(path: string): void {
	capture('$pageview', { path });
}

/** Capture a named funnel/product event. */
export function trackEvent(
	event: string,
	properties?: Record<string, unknown>,
): void {
	capture(event, properties);
}
