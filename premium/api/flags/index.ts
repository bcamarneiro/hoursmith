/**
 * GET /api/flags — public operational-flag snapshot for the SPA (ADA-341).
 * PATCH /api/flags — admin-only flag update endpoint (ADA-620).
 *
 * The GET handler returns a read-only snapshot of all operational flags resolved
 * from Edge Config → env var → hardcoded default. If a Supabase bearer token is
 * present we resolve the caller's email to compute `paywallOpenForMe` (this
 * drives the closed-launch allowlist); otherwise the snapshot reflects public
 * state only. Never cached — flag flips must take effect within one poll.
 *
 * The PATCH handler accepts partial flag updates as `{ key: value, ... }`,
 * verifies the caller is an admin (valid Supabase JWT + FLAGS_ADMIN_EMAILS),
 * persists each flag via the Vercel Edge Config write API, and returns the
 * updated snapshot.
 *
 * Both endpoints are intentionally NOT gated by maintenance/checkout switches
 * and expose no secrets — only the resolved booleans the UI needs.
 *
 * Writeable flags (Edge Config schema v1):
 *   paywall_public: boolean
 *   paywall_allow_emails: string[]
 *   polar_checkout_enabled: boolean
 *   maintenance_mode: boolean
 *   announcement_banner: string | null
 *
 * Linear: ADA-341, ADA-620.
 */

import { verifyJwt } from '../_lib/auth.js';
import { emailFromToken } from '../_lib/authEmail.js';
import { writeEdgeConfig } from '../_lib/edgeConfig.js';
import { resolveFlags, type PublicFlags } from '../_lib/flags.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface FlagsDeps {
	resolveFlags?: typeof resolveFlags;
	emailFromToken?: typeof emailFromToken;
	writeEdgeConfig?: typeof writeEdgeConfig;
	verifyJwt?: typeof verifyJwt;
	/**
	 * Comma-separated admin email allowlist for PATCH.
	 * Defaults to `process.env.FLAGS_ADMIN_EMAILS`.
	 */
	adminEmails?: string;
}

/**
 * Known writeable flag keys and their expected JSON types.
 * Used to validate PATCH payload keys against a dot-notation allowlist so we
 * don't silently persist misspelled or invented flags.
 */
const WRITEABLE_FLAG_KEYS = new Set([
	'paywall_public',
	'paywall_allow_emails',
	'polar_checkout_enabled',
	'maintenance_mode',
	'announcement_banner',
]);

export default async function handler(request: Request): Promise<Response> {
	return handleFlags(request);
}

export async function handleFlags(
	request: Request,
	deps: FlagsDeps = {},
): Promise<Response> {
	if (request.method === 'GET') {
		return handleGetFlags(request, deps);
	}
	if (request.method === 'PATCH') {
		return handlePatchFlags(request, deps);
	}
	return jsonResponse(405, { error: 'method_not_allowed' });
}

/* ------------------------------------------------------------------ */
/*  GET handler                                                        */
/* ------------------------------------------------------------------ */

async function handleGetFlags(
	request: Request,
	deps: FlagsDeps,
): Promise<Response> {
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

/* ------------------------------------------------------------------ */
/*  PATCH handler                                                      */
/* ------------------------------------------------------------------ */

interface PatchFlagsBody {
	[key: string]: unknown;
}

async function handlePatchFlags(
	request: Request,
	deps: FlagsDeps,
): Promise<Response> {
	/* ---- Auth: require a valid Supabase JWT of an admin ---- */
	const authHeader = request.headers.get('authorization');
	const token = extractBearer(authHeader);
	if (!token) {
		return jsonResponse(401, { error: 'unauthorized' });
	}

	const verify = deps.verifyJwt ?? verifyJwt;
	const verified = await verify(token, { confirmWithServer: true });
	if (!verified?.email) {
		return jsonResponse(401, { error: 'unauthorized' });
	}

	const adminEmails = deps.adminEmails ?? process.env.FLAGS_ADMIN_EMAILS ?? '';
	const admins = adminEmails
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (!admins.includes(verified.email.toLowerCase()) && !admins.includes('*')) {
		return jsonResponse(403, { error: 'forbidden' });
	}

	/* ---- Parse body ---- */
	let body: PatchFlagsBody;
	try {
		body = (await request.json()) as PatchFlagsBody;
	} catch {
		return jsonResponse(400, { error: 'invalid_json' });
	}

	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return jsonResponse(400, { error: 'invalid_body' });
	}

	const updateKeys = Object.keys(body);
	if (updateKeys.length === 0) {
		return jsonResponse(400, { error: 'no_flags_provided' });
	}

	const unknownKeys = updateKeys.filter((k) => !WRITEABLE_FLAG_KEYS.has(k));
	if (unknownKeys.length > 0) {
		return jsonResponse(400, {
			error: 'unknown_flags',
			unknown: unknownKeys,
		});
	}

	/* ---- Persist ---- */
	const write = deps.writeEdgeConfig ?? writeEdgeConfig;
	const results: Record<string, boolean> = {};

	for (const key of updateKeys) {
		results[key] = await write(key, body[key]);
	}

	const failures = updateKeys.filter((k) => !results[k]);
	if (failures.length > 0) {
		return jsonResponse(502, {
			error: 'write_failed',
			failed: failures,
		});
	}

	/* ---- Return the updated snapshot ---- */
	const resolve = deps.resolveFlags ?? resolveFlags;
	const flags = await resolve(verified.email);
	return new Response(JSON.stringify(flags), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
		},
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
