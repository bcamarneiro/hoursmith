/**
 * POST /api/csp-report — Content-Security-Policy violation collector (ADA-525).
 *
 * The CSP ships Report-Only. Without a sink the browser warns it "will not
 * block and cannot report violations" — i.e. the policy is a no-op. This
 * endpoint is that sink: browsers POST violations here either as the legacy
 * `report-uri` body (`{ "csp-report": {...} }`, kebab-case keys) or the modern
 * `report-to` body (an array of `application/reports+json` reports, camelCase
 * keys). We normalise both shapes and forward each violation to PostHog as a
 * `csp_violation` capture event, so CSP drift lands alongside the rest of
 * product analytics with no separate dashboard to wire up.
 *
 * Side-effect-only and best-effort: it always answers 204 (a telemetry sink
 * must never surface as an error in a visitor's console) and never blocks a
 * response on, or throws from, the PostHog round-trip. If no PostHog key is
 * configured it simply accepts and drops the report.
 *
 * The publishable `VITE_POSTHOG_KEY` is reused server-side (it is safe to
 * expose); `VITE_POSTHOG_HOST` mirrors the browser client's default.
 *
 * Linear: ADA-525.
 */

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

const POSTHOG_EVENT = 'csp_violation';
const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';

export interface CspReportDeps {
	posthogKey?: string;
	posthogHost?: string;
	fetchImpl?: typeof fetch;
}

interface Violation {
	documentUrl?: string;
	referrer?: string;
	violatedDirective?: string;
	effectiveDirective?: string;
	originalPolicy?: string;
	blockedUrl?: string;
	disposition?: string;
	statusCode?: number;
	sourceFile?: string;
	lineNumber?: number;
	columnNumber?: number;
}

export default async function handler(request: Request): Promise<Response> {
	return handleCspReport(request);
}

export async function handleCspReport(
	request: Request,
	deps: CspReportDeps = {},
): Promise<Response> {
	const noContent = new Response(null, { status: 204 });

	if (request.method !== 'POST') {
		return new Response(null, { status: 405 });
	}

	const key = deps.posthogKey ?? process.env.VITE_POSTHOG_KEY ?? '';
	const host = (
		deps.posthogHost ??
		process.env.VITE_POSTHOG_HOST ??
		DEFAULT_POSTHOG_HOST
	).replace(/\/+$/, '');
	if (!key) {
		return noContent;
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return noContent;
	}

	const violations = normalizeReports(raw);
	if (violations.length === 0) {
		return noContent;
	}

	const send = deps.fetchImpl ?? fetch;
	const userAgent = request.headers.get('user-agent') ?? undefined;
	await Promise.all(
		violations.map((v) =>
			forwardToPostHog(send, host, key, v, userAgent).catch(() => {
				// Best-effort: a failed forward must not surface to the browser.
			}),
		),
	);

	return noContent;
}

/** Coerce either wire format into a flat list of violations. */
function normalizeReports(raw: unknown): Violation[] {
	// Modern report-to: an array of report objects.
	if (Array.isArray(raw)) {
		return raw
			.filter(
				(r): r is { type?: string; body?: Record<string, unknown> } =>
					!!r && typeof r === 'object',
			)
			.filter((r) => r.type === 'csp-violation' && !!r.body)
			.map((r) => fromReportTo(r.body as Record<string, unknown>));
	}
	// Legacy report-uri: { "csp-report": {...} }.
	if (raw && typeof raw === 'object') {
		const legacy = (raw as Record<string, unknown>)['csp-report'];
		if (legacy && typeof legacy === 'object') {
			return [fromReportUri(legacy as Record<string, unknown>)];
		}
	}
	return [];
}

function fromReportUri(r: Record<string, unknown>): Violation {
	return {
		documentUrl: str(r['document-uri']),
		referrer: str(r.referrer),
		violatedDirective: str(r['violated-directive']),
		effectiveDirective: str(r['effective-directive']),
		originalPolicy: str(r['original-policy']),
		blockedUrl: str(r['blocked-uri']),
		disposition: str(r.disposition),
		statusCode: num(r['status-code']),
		sourceFile: str(r['source-file']),
		lineNumber: num(r['line-number']),
		columnNumber: num(r['column-number']),
	};
}

function fromReportTo(b: Record<string, unknown>): Violation {
	return {
		documentUrl: str(b.documentURL),
		referrer: str(b.referrer),
		violatedDirective: str(b.violatedDirective),
		effectiveDirective: str(b.effectiveDirective),
		originalPolicy: str(b.originalPolicy),
		blockedUrl: str(b.blockedURL),
		disposition: str(b.disposition),
		statusCode: num(b.statusCode),
		sourceFile: str(b.sourceFile),
		lineNumber: num(b.lineNumber),
		columnNumber: num(b.columnNumber),
	};
}

async function forwardToPostHog(
	send: typeof fetch,
	host: string,
	key: string,
	v: Violation,
	userAgent: string | undefined,
): Promise<void> {
	const properties: Record<string, unknown> = {
		// Anonymous telemetry — never create or update a person profile.
		$process_person_profile: false,
		document_url: v.documentUrl,
		referrer: v.referrer,
		violated_directive: v.violatedDirective,
		effective_directive: v.effectiveDirective,
		blocked_url: v.blockedUrl,
		disposition: v.disposition,
		status_code: v.statusCode,
		source_file: v.sourceFile,
		line_number: v.lineNumber,
		column_number: v.columnNumber,
		original_policy: v.originalPolicy,
		// PostHog derives $browser / $os from this property name server-side.
		$raw_user_agent: userAgent,
	};

	await send(`${host}/i/v0/e/`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			api_key: key,
			event: POSTHOG_EVENT,
			distinct_id: distinctId(v.documentUrl),
			properties,
		}),
	});
}

/**
 * Group violations by document origin rather than per-event, so the sink does
 * not explode PostHog's person/distinct-id cardinality. Falls back to a single
 * shared id when the origin can't be parsed.
 */
function distinctId(documentUrl: string | undefined): string {
	if (documentUrl) {
		try {
			return `csp:${new URL(documentUrl).host}`;
		} catch {
			// fall through
		}
	}
	return 'csp:unknown';
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}
