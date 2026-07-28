/**
 * Team accounts API (ADA-489).
 *
 * POST /api/team — Create a new team (caller becomes owner)
 * GET  /api/team — Get the caller's team (or null if not in a team)
 *
 * Prereq for per-seat Team tier pricing and the viral loop.
 *
 * Linear: ADA-489.
 */

import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface TeamDeps {
	admin?: SupabaseAdminClient;
	verifyJwt?: (token: string) => Promise<string | null>;
}

export default async function handler(request: Request): Promise<Response> {
	return handleTeam(request);
}

export async function handleTeam(
	request: Request,
	deps: TeamDeps = {},
): Promise<Response> {
	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		logEvent({ userId: null, status: 401, note: 'missing_token' });
		return jsonResponse(401, { error: 'missing_token' });
	}

	let admin: SupabaseAdminClient;
	try {
		admin = deps.admin ?? defaultSupabaseAdmin();
	} catch (err) {
		logEvent({
			userId: null,
			status: 500,
			note: `server_misconfigured:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	const verifyJwt =
		deps.verifyJwt ?? ((t: string) => admin.getUserIdFromToken(t));
	const userId = await verifyJwt(token);
	if (!userId) {
		logEvent({ userId: null, status: 401, note: 'invalid_token' });
		return jsonResponse(401, { error: 'invalid_token' });
	}

	if (request.method === 'POST') {
		return handleCreateTeam(request, userId, admin);
	}

	if (request.method === 'GET') {
		return handleGetTeam(userId, admin);
	}

	return jsonResponse(405, { error: 'method_not_allowed' });
}

async function handleCreateTeam(
	request: Request,
	userId: string,
	admin: SupabaseAdminClient,
): Promise<Response> {
	// Check if user already owns or is a member of a team
	const existingMembership = await admin.getUserTeamMembership(userId);
	if (existingMembership) {
		logEvent({ userId, status: 409, note: 'already_in_team' });
		return jsonResponse(409, { error: 'already_in_team' });
	}

	const existingTeam = await admin.getTeamByOwner(userId);
	if (existingTeam) {
		logEvent({ userId, status: 409, note: 'already_owns_team' });
		return jsonResponse(409, { error: 'already_owns_team' });
	}

	let body: { name?: string; seatLimit?: number };
	try {
		body = await request.json();
	} catch {
		return jsonResponse(400, { error: 'invalid_json' });
	}

	const name = body.name?.trim();
	if (!name || name.length < 2 || name.length > 100) {
		return jsonResponse(400, { error: 'invalid_team_name' });
	}

	const seatLimit = body.seatLimit ?? 5;
	if (seatLimit < 2 || seatLimit > 100) {
		return jsonResponse(400, { error: 'invalid_seat_limit' });
	}

	const teamId = crypto.randomUUID();

	try {
		const team = await admin.createTeam({
			id: teamId,
			name,
			ownerId: userId,
			seatLimit,
		});

		// Add the owner as the first member
		await admin.addTeamMember(teamId, userId, 'owner');

		logEvent({ userId, status: 201, note: 'team_created' });
		return jsonResponse(201, { team });
	} catch (err) {
		logEvent({
			userId,
			status: 500,
			note: `create_team_failed:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'create_team_failed' });
	}
}

async function handleGetTeam(
	userId: string,
	admin: SupabaseAdminClient,
): Promise<Response> {
	try {
		const membership = await admin.getUserTeamMembership(userId);
		if (!membership) {
			// Check if they own a team but haven't joined as member yet
			const ownedTeam = await admin.getTeamByOwner(userId);
			if (ownedTeam) {
				const members = await admin.getTeamMembers(ownedTeam.id);
				logEvent({ userId, status: 200, note: 'team_found' });
				return jsonResponse(200, { team: { ...ownedTeam, members } });
			}
			logEvent({ userId, status: 200, note: 'no_team' });
			return jsonResponse(200, { team: null });
		}

		const team = await admin.getTeamById(membership.team_id);
		if (!team) {
			logEvent({ userId, status: 200, note: 'no_team' });
			return jsonResponse(200, { team: null });
		}

		const members = await admin.getTeamMembers(team.id);
		logEvent({ userId, status: 200, note: 'team_found' });
		return jsonResponse(200, { team: { ...team, members } });
	} catch (err) {
		logEvent({
			userId,
			status: 500,
			note: `get_team_failed:${(err as Error).message}`,
		});
		return jsonResponse(500, { error: 'get_team_failed' });
	}
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
	userId: string | null;
	status: number;
	note?: string;
}

function logEvent(fields: LogFields): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			svc: 'hoursmith-team',
			user_id: fields.userId,
			status: fields.status,
			...(fields.note ? { note: fields.note } : {}),
		}),
	);
}
