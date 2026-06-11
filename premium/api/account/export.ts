/**
 * GDPR Article 20 — right to data portability.
 *
 * `GET /api/account/export` returns a JSON file containing everything
 * Hoursmith stores about the requesting user. There is intentionally very
 * little: a profile row, a subscription row, and a link to the Polar
 * customer portal for invoice history. Jira data lives entirely client-side
 * and is therefore not in scope.
 *
 * Logging discipline:
 *   DO log:    timestamp, event type, success/error code.
 *   DO NOT log: email, profile contents, the exported JSON body.
 *
 * Linear: ADA-264.
 */

import { logAuditEvent } from '../_lib/auditLog.js';
import { userIdFromToken } from '../_lib/auth.js';
import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface ExportDeps {
	admin?: SupabaseAdminClient;
	verifyJwt?: (token: string) => Promise<string | null>;
	portalUrl?: string;
}

export default async function handler(request: Request): Promise<Response> {
	return handleExport(request);
}

export async function handleExport(
	request: Request,
	deps: ExportDeps = {},
): Promise<Response> {
	if (request.method !== 'GET') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		logEvent({ event: 'data_export', status: 401, note: 'missing_token' });
		return jsonResponse(401, { error: 'missing_token' });
	}

	let admin: SupabaseAdminClient;
	try {
		admin = deps.admin ?? defaultSupabaseAdmin();
	} catch (err) {
		logEvent({
			event: 'data_export',
			status: 500,
			note: 'server_misconfigured',
		});
		return jsonResponse(500, {
			error: 'server_misconfigured',
			detail: (err as Error).message,
		});
	}

	// GDPR data export discloses personal data — require the live server check so
	// a deleted/revoked user can't export with a still-unexpired token (ADA-343).
	const verifyJwt =
		deps.verifyJwt ??
		((t: string) => userIdFromToken(t, { confirmWithServer: true }));
	const userId = await verifyJwt(token);
	if (!userId) {
		logEvent({ event: 'data_export', status: 401, note: 'invalid_token' });
		return jsonResponse(401, { error: 'invalid_token' });
	}

	let profile: Awaited<ReturnType<SupabaseAdminClient['getProfile']>>;
	let subscription: Awaited<ReturnType<SupabaseAdminClient['getSubscription']>>;
	try {
		profile = await admin.getProfile(userId);
		subscription = await admin.getSubscription(userId);
	} catch (err) {
		logEvent({
			event: 'data_export',
			status: 500,
			note: 'supabase_read_failed',
		});
		return jsonResponse(500, {
			error: 'export_failed',
			detail: (err as Error).message,
		});
	}

	if (!profile) {
		logEvent({ event: 'data_export', status: 404, note: 'profile_not_found' });
		return jsonResponse(404, { error: 'profile_not_found' });
	}

	const portalUrl =
		deps.portalUrl ??
		process.env.POLAR_CUSTOMER_PORTAL_URL ??
		'https://polar.sh';

	const body = {
		exported_at: new Date().toISOString(),
		profile: {
			id: profile.id,
			email: profile.email,
			created_at: profile.created_at,
		},
		subscription: subscription
			? {
					tier: subscription.tier,
					status: subscription.status,
					current_period_end: subscription.current_period_end,
					customer_id: subscription.stripe_customer_id,
				}
			: null,
		invoices_url: portalUrl,
		notes:
			'Jira data is not exported because it is never stored server-side. Invoices live in the linked Polar customer portal.',
	};

	try {
		await logAuditEvent(
			'data_exported',
			subscription?.stripe_customer_id ?? null,
			{},
			admin,
		);
	} catch (err) {
		logEvent({
			event: 'data_export',
			status: 200,
			note: `audit_log_failed:${(err as Error).message}`,
		});
	}

	const filename = `hoursmith-export-${todayIsoDate()}.json`;
	logEvent({ event: 'data_export', status: 200 });
	return new Response(JSON.stringify(body, null, 2), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'content-disposition': `attachment; filename="${filename}"`,
		},
	});
}

function todayIsoDate(): string {
	return new Date().toISOString().slice(0, 10);
}

function extractBearer(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

interface LogFields {
	event: string;
	status: number;
	note?: string;
}

function logEvent(fields: LogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-account',
			event: fields.event,
			status: fields.status,
			...(fields.note ? { note: fields.note } : {}),
		}),
	);
}
