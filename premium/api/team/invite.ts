/**
 * Team invite API (ADA-489).
 *
 * POST /api/team/invite — Create an invite (owner/admin only)
 * POST /api/team/accept-invite — Accept an invite by token
 * GET  /api/team/invites — List pending invites (owner/admin only)
 *
 * Linear: ADA-489.
 */

import {
	defaultSupabaseAdmin,
	type SupabaseAdminClient,
} from '../_lib/supabaseAdmin.js';
import type { TeamRole } from '../../../types/team.js';

export const config = {
	runtime: 'edge',
	regions: ['fra1'],
};

export interface InviteDeps {
	admin?: SupabaseAdminClient;
	verifyJwt?: (token: string) => Promise<string | null>;
}

export default async function handler(request: Request): Promise<Response> {
	return handleTeamInvite(request);
}

export async function handleTeamInvite(
	request: Request,
	deps: InviteDeps = {},
): Promise<Response> {
	const token = extractBearer(request.headers.get('authorization'));
	if (!token) {
		return jsonResponse(401, { error: 'missing_token' });
	}

	let admin: SupabaseAdminClient;
	try {
		admin = deps.admin ?? defaultSupabaseAdmin();
	} catch {
		return jsonResponse(500, { error: 'server_misconfigured' });
	}

	const verifyJwt =
		deps.verifyJwt ?? ((t: string) => admin.getUserIdFromToken(t));
	const userId = await verifyJwt(token);
	if (!userId) {
		return jsonResponse(401, { error: 'invalid_token' });
	}

	const url = new URL(request.url);
	const path = url.pathname;

	if (path.endsWith('/accept-invite') && request.method === 'POST') {
		return handleAcceptInvite(request, userId, admin);
	}

	if (path.endsWith('/invites') && request.method === 'GET') {
		return handleListInvites(userId, admin);
	}

	if (request.method === 'POST') {
		return handleCreateInvite(request, userId, admin);
	}

	return jsonResponse(405, { error: 'method_not_allowed' });
}

async function handleCreateInvite(
	request: Request,
	userId: string,
	admin: SupabaseAdminClient,
): Promise<Response> {
	// Verify caller is owner or admin of a team
	const membership = await admin.getUserTeamMembership(userId);
	if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
		return jsonResponse(403, { error: 'not_authorized' });
	}

	// Check seat limit
	const team = await admin.getTeamById(membership.team_id);
	if (!team) {
		return jsonResponse(404, { error: 'team_not_found' });
	}

	const members = await admin.getTeamMembers(team.id);
	if (members.length >= team.seat_limit) {
		return jsonResponse(402, { error: 'seat_limit_reached' });
	}

	let body: { email?: string; role?: TeamRole };
	try {
		body = await request.json();
	} catch {
		return jsonResponse(400, { error: 'invalid_json' });
	}

	const email = body.email?.trim().toLowerCase();
	if (!email || !email.includes('@')) {
		return jsonResponse(400, { error: 'invalid_email' });
	}

	const role = body.role ?? 'member';
	if (!['admin', 'member'].includes(role)) {
		return jsonResponse(400, { error: 'invalid_role' });
	}

	// Check if already a member
	const existingProfile = await admin.getProfileByEmail(email);
	if (existingProfile) {
		const existingMembership = await admin.getTeamMembership(team.id, existingProfile.id);
		if (existingMembership) {
			return jsonResponse(409, { error: 'already_member' });
		}
	}

	// Check for existing pending invite
	const existingInvites = await admin.getTeamInvites(team.id);
	const pendingInvite = existingInvites.find(
		(i) => i.email === email && !i.accepted_at && new Date(i.expires_at) > new Date(),
	);
	if (pendingInvite) {
		return jsonResponse(409, { error: 'invite_already_pending' });
	}

	const inviteId = crypto.randomUUID();
	const inviteToken = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

	try {
		const invite = await admin.createTeamInvite({
			id: inviteId,
			teamId: team.id,
			email,
			role,
			token: inviteToken,
			invitedBy: userId,
			expiresAt,
		});

		return jsonResponse(201, { invite });
	} catch {
		return jsonResponse(500, { error: 'create_invite_failed' });
	}
}

async function handleAcceptInvite(
	request: Request,
	userId: string,
	admin: SupabaseAdminClient,
): Promise<Response> {
	let body: { token?: string };
	try {
		body = await request.json();
	} catch {
		return jsonResponse(400, { error: 'invalid_json' });
	}

	const inviteToken = body.token?.trim();
	if (!inviteToken) {
		return jsonResponse(400, { error: 'missing_token' });
	}

	const invite = await admin.getTeamInviteByToken(inviteToken);
	if (!invite) {
		return jsonResponse(404, { error: 'invite_not_found' });
	}

	if (invite.accepted_at) {
		return jsonResponse(409, { error: 'invite_already_accepted' });
	}

	if (new Date(invite.expires_at) < new Date()) {
		return jsonResponse(410, { error: 'invite_expired' });
	}

	// Verify the invite is for this user's email
	const profile = await admin.getProfile(userId);
	if (!profile || profile.email !== invite.email) {
		return jsonResponse(403, { error: 'email_mismatch' });
	}

	// Check seat limit
	const team = await admin.getTeamById(invite.team_id);
	if (!team) {
		return jsonResponse(404, { error: 'team_not_found' });
	}

	const members = await admin.getTeamMembers(team.id);
	if (members.length >= team.seat_limit) {
		return jsonResponse(402, { error: 'seat_limit_reached' });
	}

	try {
		await admin.addTeamMember(invite.team_id, userId, invite.role);
		await admin.markInviteAccepted(invite.id);

		return jsonResponse(200, { team_id: invite.team_id });
	} catch {
		return jsonResponse(500, { error: 'accept_invite_failed' });
	}
}

async function handleListInvites(
	userId: string,
	admin: SupabaseAdminClient,
): Promise<Response> {
	const membership = await admin.getUserTeamMembership(userId);
	if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
		return jsonResponse(403, { error: 'not_authorized' });
	}

	try {
		const invites = await admin.getTeamInvites(membership.team_id);
		const pending = invites.filter(
			(i) => !i.accepted_at && new Date(i.expires_at) > new Date(),
		);
		return jsonResponse(200, { invites: pending });
	} catch {
		return jsonResponse(500, { error: 'list_invites_failed' });
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
