/**
 * GET /api/flags — public operational-flag snapshot for the SPA (ADA-341).
 *
 * A static SPA can't read Edge Config directly, so it polls this endpoint. If a
 * Supabase bearer token is present we resolve the caller's email to compute
 * `paywallOpenForMe` (this drives the closed-launch allowlist); otherwise the
 * snapshot reflects public state only. Never cached — flag flips must take
 * effect within one poll.
 *
 * This endpoint is intentionally NOT gated by maintenance/checkout switches and
 * exposes no secrets — only the resolved booleans the UI needs.
 *
 * Linear: ADA-341.
 */

import { emailFromToken } from '../_lib/authEmail.js';
import { resolveFlags } from '../_lib/flags.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface FlagsDeps {
	resolveFlags?: typeof resolveFlags;
	emailFromToken?: typeof emailFromToken;
}

export default async function handler(request: Request): Promise<Response> {
	return handleFlags(request);
}

export async function handleFlags(
	request: Request,
	deps: FlagsDeps = {},
): Promise<Response> {
	if (request.method !== 'GET') {
		return jsonResponse(405, { error: 'method_not_allowed' });
	}

	const resolve = deps.resolveFlags ?? resolveFlags;
	const resolveEmail = deps.emailFromToken ?? emailFromToken;

	let email: string | null = null;
	const token = extractBearer(request.headers.get('authorization'));
	if (token) {
		email = await resolveEmail(token);
	}

	const flags = await resolve(email);
	return new Response(JSON.stringify(flags), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
		},
	});
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
