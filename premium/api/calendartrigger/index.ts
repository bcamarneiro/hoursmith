/**
 * POST /api/calendartrigger — calendar date-list integration trigger (ADA-627).
 *
 * Invoked by the frontend after calendar date-list data is successfully
 * integrated into the dashboard. Verifies the caller's Supabase JWT and
 * persists `calendar_date_list_triggered` (ISO timestamp) via the Edge
 * Config write API so downstream analytics / audits can observe the event.
 *
 * This is a user-endpoint (not admin-gated) — any authenticated user who
 * has calendar feeds configured can fire it. The write is fire-and-forget
 * from the frontend perspective; failures are silent there.
 *
 * Linear: ADA-627.
 */

import { verifyJwt } from '../_lib/auth.js';
import { writeEdgeConfig } from '../_lib/edgeConfig.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface CalendarTriggerDeps {
	verifyJwt?: typeof verifyJwt;
	writeEdgeConfig?: typeof writeEdgeConfig;
}

export default async function handler(request: Request): Promise<Response> {
	return handleCalendarTrigger(request);
}

export async function handleCalendarTrigger(
	request: Request,
	deps: CalendarTriggerDeps = {},
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	/* ---- Auth: require a valid Supabase JWT ---- */
	const authHeader = request.headers.get('authorization');
	const token = extractBearer(authHeader);
	if (!token) {
		return jsonResponse(401, { error: 'unauthorized' });
	}

	const verify = deps.verifyJwt ?? verifyJwt;
	const verified = await verify(token);
	if (!verified?.userId) {
		return jsonResponse(401, { error: 'unauthorized' });
	}

	/* ---- Persist the trigger timestamp ---- */
	const write = deps.writeEdgeConfig ?? writeEdgeConfig;
	const ts = Date.now().toString();
	const ok = await write('calendar_date_list_triggered', ts);

	if (!ok) {
		return jsonResponse(502, { error: 'write_failed' });
	}

	return jsonResponse(200, {
		ok: true,
		key: 'calendar_date_list_triggered',
		ts,
	});
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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
