/**
 * GET/PATCH /api/flags — public operational-flag snapshot for the SPA (ADA-341).
 *
 * A static SPA can't read Edge Config directly, so it polls this endpoint. If a
 * Supabase bearer token is present we resolve the caller's email to compute
 * `paywallOpenForMe` (this drives the closed-launch allowlist); otherwise the
 * snapshot reflects public state only. Never cached — flag flips must take
 * effect within one poll.
 *
 * PATCH accepts a partial `PublicFlags` body and writes the fields to Edge
 * Config, then returns the full updated snapshot. Only recognised flag keys
 * are accepted; unknown fields are rejected with 422.
 *
 * This endpoint is intentionally NOT gated by maintenance/checkout switches and
 * exposes no secrets — only the resolved booleans the UI needs.
 *
 * Linear: ADA-341 (GET), ADA-626 (PATCH).
 */

import { emailFromToken } from '../_lib/authEmail.js';
import { resolveFlags, writeFlags } from '../_lib/flags.js';
import type { PublicFlags } from '../_lib/flags.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

const FLAG_KEYS: ReadonlySet<string> = new Set([
	'maintenanceMode',
	'checkoutEnabled',
	'paywallPublic',
	'paywallOpenForMe',
	'announcementBanner',
]);

export interface FlagsDeps {
	resolveFlags?: typeof resolveFlags;
	writeFlags?: typeof writeFlags;
	emailFromToken?: typeof emailFromToken;
}

export default async function handler(request: Request): Promise<Response> {
	return handleFlags(request);
}

export async function handleFlags(
	request: Request,
	deps: FlagsDeps = {},
): Promise<Response> {
	const doResolve = deps.resolveFlags ?? resolveFlags;
	const doWrite = deps.writeFlags ?? writeFlags;
	const resolveEmail = deps.emailFromToken ?? emailFromToken;

	let email: string | null = null;
	const token = extractBearer(request.headers.get('authorization'));
	if (token) {
		email = await resolveEmail(token);
	}

	if (request.method === 'GET') {
		const flags = await doResolve(email);
		return new Response(JSON.stringify(flags), {
			status: 200,
			headers: {
				'content-type': 'application/json',
				'cache-control': 'no-store',
			},
		});
	}

	if (request.method === 'PATCH') {
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return jsonResponse(400, { error: 'invalid_json' });
		}

		const unknownKeys = Object.keys(body).filter((k) => !FLAG_KEYS.has(k));
		if (unknownKeys.length > 0) {
			return jsonResponse(422, {
				error: 'unknown_fields',
				fields: unknownKeys,
			});
		}

		const allowed: Partial<PublicFlags> = {};
		for (const key of FLAG_KEYS) {
			if (key in body) {
				(allowed as Record<string, unknown>)[key] = body[key];
			}
		}

		const writeError = await doWrite(allowed);
		if (writeError) {
			return jsonResponse(502, { error: writeError });
		}

		const flags = await doResolve(email);
		return new Response(JSON.stringify(flags), {
			status: 200,
			headers: {
				'content-type': 'application/json',
				'cache-control': 'no-store',
			},
		});
	}

	return jsonResponse(405, { error: 'method_not_allowed' });
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
