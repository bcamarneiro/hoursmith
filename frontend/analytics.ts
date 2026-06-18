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

import type { CaptureResult, PostHog } from 'posthog-js';
import { useConfigStore } from './stores/useConfigStore';

const KEY = process.env.VITE_POSTHOG_KEY || '';
const HOST = process.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com';

let instance: PostHog | null = null;
let pending: Array<[string, Record<string, unknown> | undefined]> = [];

/**
 * Whether analytics is suppressed for this user/session.
 *
 * Two independent opt-out signals, checked on every init/capture so a mid-session
 * toggle takes effect immediately:
 *   - the in-app `analyticsOptOut` config flag (read-only here — owned by
 *     `useConfigStore`; coded defensively in case the field isn't present yet).
 *   - the browser-level Do Not Track signal (`navigator.doNotTrack === '1'`).
 */
function isOptedOut(): boolean {
	try {
		// `analyticsOptOut` is owned by useConfigStore (read-only here). Optional
		// access keeps this resilient if the store isn't initialised yet.
		if (useConfigStore.getState().config?.analyticsOptOut === true) return true;
	} catch {
		// Store not ready / unavailable — fall through to DNT check.
	}
	if (
		typeof navigator !== 'undefined' &&
		(navigator.doNotTrack === '1' ||
			// Legacy vendor-prefixed signals.
			(navigator as { msDoNotTrack?: string }).msDoNotTrack === '1' ||
			(window as { doNotTrack?: string }).doNotTrack === '1')
	)
		return true;
	return false;
}

/**
 * PostHog Error Tracking can ship raw exception messages and stack traces. In
 * this app those strings can embed Jira-derived data (issue keys, JQL, host
 * names, tokens in URLs). We never want that to leave the browser, so every
 * exception event is scrubbed in `before_send` before transmission: the
 * human-readable message + stack are replaced with a fixed redaction marker,
 * keeping only the (benign) exception *type*. If the shape is unexpected we drop
 * the event entirely rather than risk leaking text.
 */
const REDACTED = '[redacted: exception detail withheld to protect Jira data]';

export function sanitizeExceptionEvent(
	event: CaptureResult | null,
): CaptureResult | null {
	if (!event) return event;
	if (event.event !== '$exception') return event;

	const props = event.properties;
	if (!props || typeof props !== 'object') return null;

	const list = props.$exception_list;
	if (!Array.isArray(list)) {
		// Unknown exception shape — don't risk shipping unsanitized text.
		return null;
	}

	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const ex = item as Record<string, unknown>;
		// Keep only the exception type (e.g. "TypeError"); redact everything that
		// could carry Jira-derived text.
		ex.value = REDACTED;
		if ('stacktrace' in ex) ex.stacktrace = undefined;
	}

	// Belt-and-braces: redact the top-level mirrors PostHog also sets.
	if ('$exception_message' in props) props.$exception_message = REDACTED;
	if ('$exception_stack_trace_raw' in props)
		props.$exception_stack_trace_raw = REDACTED;

	return event;
}

export function initAnalytics(): void {
	if (!KEY || instance) return;
	if (isOptedOut()) return; // honor opt-out / DNT before loading the SDK
	void import('posthog-js').then(({ default: posthog }) => {
		posthog.init(KEY, {
			api_host: HOST,
			persistence: 'memory',
			autocapture: false,
			capture_pageview: false,
			disable_session_recording: true,
			person_profiles: 'identified_only',
			// Error Tracking: autocapture unhandled JS errors + promise rejections
			// so we surface silent bugs during the dogfooding period. The message +
			// stack are scrubbed in `before_send` (see sanitizeExceptionEvent) so no
			// raw Jira-derived text can leave the browser.
			capture_exceptions: true,
			before_send: sanitizeExceptionEvent,
		});
		instance = posthog;
		for (const [event, properties] of pending)
			posthog.capture(event, properties);
		pending = [];
	});
}

function capture(event: string, properties?: Record<string, unknown>): void {
	if (!KEY) return; // analytics disabled — drop silently
	if (isOptedOut()) return; // honor opt-out / DNT
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

/**
 * Report a caught error to PostHog Error Tracking (e.g. from a React error
 * boundary — those don't reach the global handler `capture_exceptions` hooks).
 * No-op until the SDK is initialised.
 */
export function captureException(
	error: unknown,
	properties?: Record<string, unknown>,
): void {
	if (!KEY || !instance) return;
	if (isOptedOut()) return; // honor opt-out / DNT
	// Routed through the same `before_send` sanitizer as autocaptured exceptions,
	// so the message + stack are redacted before transmission.
	instance.captureException(error, properties);
}
