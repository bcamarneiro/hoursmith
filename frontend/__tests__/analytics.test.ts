/**
 * Tests for the analytics privacy guarantees (ADA-472).
 *
 * Two concerns:
 *   1. The exception sanitizer (`before_send`) must strip any Jira-derived text
 *      (issue keys, JQL, hostnames, tokens) from $exception events before they
 *      leave the browser, keeping only the benign exception type.
 *   2. Opt-out signals — the in-app `analyticsOptOut` config flag and the
 *      browser Do Not Track signal — must suppress init and capture entirely.
 *
 * `KEY` is read from `process.env.VITE_POSTHOG_KEY` at module load, so each test
 * sets the env and re-imports the module via `vi.resetModules()` + dynamic
 * import. posthog-js is mocked so nothing is actually sent.
 */

import type { CaptureResult } from 'posthog-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfigStore } from '../stores/useConfigStore';

const ORIGINAL_KEY = process.env.VITE_POSTHOG_KEY;

// A shared spy for posthog.init / capture across re-imports.
const initSpy = vi.fn();
const captureSpy = vi.fn();

vi.mock('posthog-js', () => ({
	default: {
		init: initSpy,
		capture: captureSpy,
		captureException: vi.fn(),
	},
}));

async function loadAnalytics() {
	vi.resetModules();
	return import('../analytics');
}

function setDoNotTrack(value: string | null) {
	Object.defineProperty(navigator, 'doNotTrack', {
		value,
		configurable: true,
		writable: true,
	});
}

beforeEach(() => {
	initSpy.mockClear();
	captureSpy.mockClear();
	process.env.VITE_POSTHOG_KEY = 'phc_test_key';
	setDoNotTrack(null);
	useConfigStore.setState((s) => ({
		config: { ...s.config, analyticsOptOut: false },
	}));
});

afterEach(() => {
	if (ORIGINAL_KEY === undefined) delete process.env.VITE_POSTHOG_KEY;
	else process.env.VITE_POSTHOG_KEY = ORIGINAL_KEY;
	setDoNotTrack(null);
	vi.restoreAllMocks();
});

describe('sanitizeExceptionEvent', () => {
	it('redacts the message and stack of $exception events', async () => {
		const { sanitizeExceptionEvent } = await loadAnalytics();
		const event = {
			event: '$exception',
			properties: {
				$exception_message: 'Failed to load ABC-123 from acme.atlassian.net',
				$exception_stack_trace_raw: 'at fetchIssue (jql=project=SECRET)',
				$exception_list: [
					{
						type: 'TypeError',
						value: 'Cannot read ABC-123 on https://acme.atlassian.net',
						stacktrace: { frames: [{ filename: 'secret.ts' }] },
					},
				],
			},
		} as unknown as CaptureResult;

		const result = sanitizeExceptionEvent(event);
		expect(result).not.toBeNull();
		const serialized = JSON.stringify(result);
		// No Jira-derived text survives.
		expect(serialized).not.toContain('ABC-123');
		expect(serialized).not.toContain('atlassian.net');
		expect(serialized).not.toContain('SECRET');
		expect(serialized).not.toContain('secret.ts');
		// The benign exception type is retained.
		expect(result?.properties.$exception_list[0].type).toBe('TypeError');
	});

	it('drops $exception events with an unexpected shape', async () => {
		const { sanitizeExceptionEvent } = await loadAnalytics();
		const event = {
			event: '$exception',
			properties: { something: 'unexpected' },
		} as unknown as CaptureResult;
		expect(sanitizeExceptionEvent(event)).toBeNull();
	});

	it('passes non-exception events through unchanged', async () => {
		const { sanitizeExceptionEvent } = await loadAnalytics();
		const event = {
			event: '$pageview',
			properties: { path: '/my-week' },
		} as unknown as CaptureResult;
		expect(sanitizeExceptionEvent(event)).toBe(event);
	});

	it('passes null through', async () => {
		const { sanitizeExceptionEvent } = await loadAnalytics();
		expect(sanitizeExceptionEvent(null)).toBeNull();
	});
});

describe('opt-out suppression', () => {
	it('does not init when analyticsOptOut is true', async () => {
		useConfigStore.setState((s) => ({
			config: { ...s.config, analyticsOptOut: true },
		}));
		const { initAnalytics } = await loadAnalytics();
		initAnalytics();
		await Promise.resolve();
		expect(initSpy).not.toHaveBeenCalled();
	});

	it('does not init when Do Not Track is enabled', async () => {
		setDoNotTrack('1');
		const { initAnalytics } = await loadAnalytics();
		initAnalytics();
		await Promise.resolve();
		expect(initSpy).not.toHaveBeenCalled();
	});

	it('initialises with the before_send sanitizer when not opted out', async () => {
		const { initAnalytics } = await loadAnalytics();
		initAnalytics();
		// Let the dynamic `import('posthog-js')` promise chain settle.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(initSpy).toHaveBeenCalledTimes(1);
		const config = initSpy.mock.calls[0][1];
		expect(config.capture_exceptions).toBe(true);
		expect(typeof config.before_send).toBe('function');
	});

	it('does not buffer or capture events when opted out', async () => {
		useConfigStore.setState((s) => ({
			config: { ...s.config, analyticsOptOut: true },
		}));
		const { trackEvent, initAnalytics } = await loadAnalytics();
		trackEvent('cta_create_account', { location: 'home' });
		initAnalytics();
		await Promise.resolve();
		// Nothing buffered means nothing flushes even if SDK later inits.
		expect(captureSpy).not.toHaveBeenCalled();
	});
});
