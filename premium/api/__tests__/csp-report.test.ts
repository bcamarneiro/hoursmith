/**
 * CSP violation collector (ADA-525).
 *
 * `/api/csp-report` is the sink that turns the Report-Only CSP from a no-op
 * into something useful: it accepts violation reports in BOTH wire formats
 * browsers use — the legacy `report-uri` body (`{ "csp-report": {...} }`) and
 * the modern `report-to` body (an array of `application/reports+json` reports)
 * — normalises them, and forwards each to PostHog as a `csp_violation` event.
 *
 * The endpoint is side-effect-only and best-effort: it must always answer 204
 * (a telemetry sink must never surface as an error in a visitor's console) and
 * must never throw, even on malformed input or a failing PostHog round-trip.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCspReport } from '../csp-report/index.js';

const KEY = 'phc_test_key';

function post(body: unknown, contentType = 'application/csp-report'): Request {
	return new Request('https://hoursmith.io/api/csp-report', {
		method: 'POST',
		headers: { 'content-type': contentType, 'user-agent': 'test-agent' },
		body: JSON.stringify(body),
	});
}

function okFetch() {
	return vi.fn(
		async (_url: RequestInfo | URL, _init?: RequestInit) =>
			new Response(null, { status: 200 }),
	);
}

const REPORT_URI_BODY = {
	'csp-report': {
		'document-uri': 'https://hoursmith.io/my-week',
		referrer: '',
		'violated-directive': 'font-src',
		'effective-directive': 'font-src',
		'original-policy': "default-src 'self'",
		'blocked-uri': 'https://fonts.gstatic.com/s/x.woff2',
		disposition: 'report',
		'status-code': 200,
		'source-file': 'https://hoursmith.io/app.css',
		'line-number': 12,
		'column-number': 3,
	},
};

const REPORT_TO_BODY = [
	{
		type: 'csp-violation',
		age: 0,
		url: 'https://hoursmith.io/my-week',
		user_agent: 'browser',
		body: {
			documentURL: 'https://hoursmith.io/my-week',
			violatedDirective: 'font-src',
			effectiveDirective: 'font-src',
			blockedURL: 'https://fonts.gstatic.com/s/x.woff2',
			disposition: 'report',
			statusCode: 200,
		},
	},
];

describe('handleCspReport', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('rejects non-POST methods', async () => {
		const fetchImpl = okFetch();
		const res = await handleCspReport(
			new Request('https://hoursmith.io/api/csp-report'),
			{ posthogKey: KEY, fetchImpl },
		);
		expect(res.status).toBe(405);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('accepts but drops the report when no PostHog key is configured', async () => {
		const fetchImpl = okFetch();
		const res = await handleCspReport(post(REPORT_URI_BODY), {
			posthogKey: '',
			fetchImpl,
		});
		expect(res.status).toBe(204);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('forwards a legacy report-uri violation to PostHog', async () => {
		const fetchImpl = okFetch();
		const res = await handleCspReport(post(REPORT_URI_BODY), {
			posthogKey: KEY,
			posthogHost: 'https://eu.i.posthog.com',
			fetchImpl,
		});
		expect(res.status).toBe(204);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		const [url, init] = fetchImpl.mock.calls[0];
		expect(String(url)).toBe('https://eu.i.posthog.com/i/v0/e/');
		const payload = JSON.parse(init?.body as string);
		expect(payload.api_key).toBe(KEY);
		expect(payload.event).toBe('csp_violation');
		expect(payload.properties.violated_directive).toBe('font-src');
		expect(payload.properties.blocked_url).toBe(
			'https://fonts.gstatic.com/s/x.woff2',
		);
		// Never build a person profile out of anonymous telemetry.
		expect(payload.properties.$process_person_profile).toBe(false);
	});

	it('forwards modern report-to (reports+json) violations', async () => {
		const fetchImpl = okFetch();
		const res = await handleCspReport(
			post(REPORT_TO_BODY, 'application/reports+json'),
			{ posthogKey: KEY, fetchImpl },
		);
		expect(res.status).toBe(204);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
		expect(payload.properties.blocked_url).toBe(
			'https://fonts.gstatic.com/s/x.woff2',
		);
	});

	it('ignores non-CSP entries in a report-to batch', async () => {
		const fetchImpl = okFetch();
		await handleCspReport(
			post(
				[{ type: 'deprecation', body: {} }, ...REPORT_TO_BODY],
				'application/reports+json',
			),
			{ posthogKey: KEY, fetchImpl },
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('answers 204 on malformed JSON without throwing', async () => {
		const fetchImpl = okFetch();
		const bad = new Request('https://hoursmith.io/api/csp-report', {
			method: 'POST',
			headers: { 'content-type': 'application/csp-report' },
			body: 'not json{',
		});
		const res = await handleCspReport(bad, { posthogKey: KEY, fetchImpl });
		expect(res.status).toBe(204);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('stays 204 when the PostHog round-trip fails', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('network down');
		});
		const res = await handleCspReport(post(REPORT_URI_BODY), {
			posthogKey: KEY,
			fetchImpl,
		});
		expect(res.status).toBe(204);
	});
});
