/**
 * Team accounts and seat model types (ADA-489).
 *
 * Prereq for per-seat Team tier pricing and the viral loop:
 * lead invites teammates → teammates become users → a teammate becomes
 * a lead elsewhere.
 */

export type TeamRole = 'owner' | 'admin' | 'member';

export interface Team {
	id: string;
	name: string;
	owner_id: string;
	seat_limit: number;
	created_at: string;
	updated_at: string;
}

export interface TeamMembership {
	team_id: string;
	user_id: string;
	role: TeamRole;
	joined_at: string;
}

export interface TeamInvite {
	id: string;
	team_id: string;
	email: string;
	role: TeamRole;
	token: string;
	invited_by: string;
	expires_at: string;
	accepted_at: string | null;
	created_at: string;
}

export interface TeamWithMembers extends Team {
	members: Array<TeamMembership & { email: string }>;
}

export interface TeamInviteWithDetails extends TeamInvite {
	team_name: string;
	inviter_email: string;
}
