/**
 * Unit tests for team invite API (ADA-489).
 *
 * POST /api/team/invite — Create an invite
 * POST /api/team/accept-invite — Accept an invite
 * GET  /api/team/invites — List pending invites
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handleTeamInvite } from '../invite';

function makeRequest(
	method: string,
	url: string,
	headers: Record<string, string> = {},
	body?: unknown,
): Request {
	return new Request(url, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
}

const TEAM = {
	id: 'team-1',
	name: 'Test Team',
	owner_id: 'user-1',
	seat_limit: 5,
	created_at: '2026-01-01T00:00:00Z',
	updated_at: '2026-01-01T00:00:00Z',
};

const MEMBERSHIP = {
	team_id: 'team-1',
	user_id: 'user-1',
	role: 'owner' as const,
	joined_at: '2026-01-01T00:00:00Z',
	team_name: 'Test Team',
};

const INVITE = {
	id: 'invite-1',
	team_id: 'team-1',
	email: 'newuser@test.com',
	role: 'member' as const,
	token: 'invite-token-123',
	invited_by: 'user-1',
	expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
	accepted_at: null,
	created_at: '2026-01-01T00:00:00Z',
};

function makeAdmin(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		getUserIdFromToken: vi.fn().mockResolvedValue('user-1'),
		getProfile: vi.fn().mockResolvedValue({ id: 'user-1', email: 'owner@test.com', created_at: '2026-01-01T00:00:00Z' }),
		getSubscription: vi.fn(),
		getSubscriptionByCustomerId: vi.fn(),
		insertIncompleteSubscription: vi.fn(),
		upsertSubscription: vi.fn(),
		deleteSubscription: vi.fn(),
		deleteProfile: vi.fn(),
		deleteAuthUser: vi.fn(),
		signOutUser: vi.fn().mockResolvedValue(undefined),
		insertAuditLog: vi.fn(),
		recordBillingEvent: vi.fn().mockResolvedValue(true),
		getTeamByOwner: vi.fn(),
		getTeamById: vi.fn().mockResolvedValue(TEAM),
		getTeamByInviteToken: vi.fn(),
		createTeam: vi.fn(),
		updateTeamSeatLimit: vi.fn(),
		deleteTeam: vi.fn(),
		getTeamMembers: vi.fn().mockResolvedValue([{ ...MEMBERSHIP, email: 'owner@test.com' }]),
		getTeamMembership: vi.fn(),
		getUserTeamMembership: vi.fn().mockResolvedValue(MEMBERSHIP),
		addTeamMember: vi.fn(),
		removeTeamMember: vi.fn(),
		updateMemberRole: vi.fn(),
		createTeamInvite: vi.fn().mockResolvedValue(INVITE),
		getTeamInviteByToken: vi.fn().mockResolvedValue(INVITE),
		getTeamInvites: vi.fn().mockResolvedValue([]),
		markInviteAccepted: vi.fn(),
		deleteTeamInvite: vi.fn(),
		getProfileByEmail: vi.fn().mockResolvedValue(null),
		...overrides,
	};
}

describe('POST /api/team/invite', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const admin = makeAdmin();
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/invite'),
			{ admin },
		);
		expect(res.status).toBe(401);
	});

	it('returns 403 when user is not owner or admin', async () => {
		const admin = makeAdmin({
			getUserTeamMembership: vi.fn().mockResolvedValue({
				...MEMBERSHIP,
				role: 'member',
			}),
		});
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/invite', { authorization: 'Bearer ok' }, { email: 'new@test.com' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-1') },
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'not_authorized' });
	});

	it('returns 402 when seat limit is reached', async () => {
		const admin = makeAdmin({
			getTeamById: vi.fn().mockResolvedValue({ ...TEAM, seat_limit: 1 }),
			getTeamMembers: vi.fn().mockResolvedValue([
				{ ...MEMBERSHIP, email: 'owner@test.com' },
			]),
		});
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/invite', { authorization: 'Bearer ok' }, { email: 'new@test.com' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-1') },
		);
		expect(res.status).toBe(402);
		expect(await res.json()).toEqual({ error: 'seat_limit_reached' });
	});

	it('returns 400 for invalid email', async () => {
		const admin = makeAdmin();
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/invite', { authorization: 'Bearer ok' }, { email: 'notanemail' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-1') },
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_email' });
	});

	it('returns 409 when user is already a member', async () => {
		const admin = makeAdmin({
			getProfileByEmail: vi.fn().mockResolvedValue({ id: 'user-2', email: 'existing@test.com', created_at: '2026-01-01T00:00:00Z' }),
			getTeamMembership: vi.fn().mockResolvedValue({ team_id: 'team-1', user_id: 'user-2', role: 'member', joined_at: '2026-01-01T00:00:00Z' }),
		});
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/invite', { authorization: 'Bearer ok' }, { email: 'existing@test.com' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-1') },
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'already_member' });
	});

	it('returns 409 when invite is already pending', async () => {
		const admin = makeAdmin({
			getTeamInvites: vi.fn().mockResolvedValue([INVITE]),
		});
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/invite', { authorization: 'Bearer ok' }, { email: 'newuser@test.com' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-1') },
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'invite_already_pending' });
	});

	it('creates an invite successfully', async () => {
		const admin = makeAdmin();
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/invite', { authorization: 'Bearer ok' }, { email: 'new@test.com', role: 'member' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-1') },
		);
		expect(res.status).toBe(201);
		expect(admin.createTeamInvite).toHaveBeenCalledWith(
			expect.objectContaining({
				teamId: 'team-1',
				email: 'new@test.com',
				role: 'member',
				invitedBy: 'user-1',
			}),
		);
	});
});

describe('POST /api/team/accept-invite', () => {
	it('returns 400 when token is missing', async () => {
		const admin = makeAdmin();
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/accept-invite', { authorization: 'Bearer ok' }, {}),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-2') },
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'missing_token' });
	});

	it('returns 404 when invite is not found', async () => {
		const admin = makeAdmin({
			getTeamInviteByToken: vi.fn().mockResolvedValue(null),
		});
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/accept-invite', { authorization: 'Bearer ok' }, { token: 'bad-token' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-2') },
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'invite_not_found' });
	});

	it('returns 409 when invite is already accepted', async () => {
		const admin = makeAdmin({
			getTeamInviteByToken: vi.fn().mockResolvedValue({
				...INVITE,
				accepted_at: '2026-01-02T00:00:00Z',
			}),
		});
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/accept-invite', { authorization: 'Bearer ok' }, { token: 'invite-token-123' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-2') },
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'invite_already_accepted' });
	});

	it('returns 410 when invite is expired', async () => {
		const admin = makeAdmin({
			getTeamInviteByToken: vi.fn().mockResolvedValue({
				...INVITE,
				expires_at: new Date(Date.now() - 1000).toISOString(),
			}),
		});
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/accept-invite', { authorization: 'Bearer ok' }, { token: 'invite-token-123' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-2') },
		);
		expect(res.status).toBe(410);
		expect(await res.json()).toEqual({ error: 'invite_expired' });
	});

	it('returns 403 when email does not match', async () => {
		const admin = makeAdmin({
			getProfile: vi.fn().mockResolvedValue({ id: 'user-2', email: 'wrong@test.com', created_at: '2026-01-01T00:00:00Z' }),
		});
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/accept-invite', { authorization: 'Bearer ok' }, { token: 'invite-token-123' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-2') },
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'email_mismatch' });
	});

	it('accepts invite and adds member successfully', async () => {
		const admin = makeAdmin({
			getProfile: vi.fn().mockResolvedValue({ id: 'user-2', email: 'newuser@test.com', created_at: '2026-01-01T00:00:00Z' }),
		});
		const res = await handleTeamInvite(
			makeRequest('POST', 'https://hoursmith.io/api/team/accept-invite', { authorization: 'Bearer ok' }, { token: 'invite-token-123' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-2') },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ team_id: 'team-1' });
		expect(admin.addTeamMember).toHaveBeenCalledWith('team-1', 'user-2', 'member');
		expect(admin.markInviteAccepted).toHaveBeenCalledWith('invite-1');
	});
});

describe('GET /api/team/invites', () => {
	it('returns 403 when user is not owner or admin', async () => {
		const admin = makeAdmin({
			getUserTeamMembership: vi.fn().mockResolvedValue({
				...MEMBERSHIP,
				role: 'member',
			}),
		});
		const res = await handleTeamInvite(
			makeRequest('GET', 'https://hoursmith.io/api/team/invites', { authorization: 'Bearer ok' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-1') },
		);
		expect(res.status).toBe(403);
	});

	it('returns pending invites', async () => {
		const admin = makeAdmin({
			getTeamInvites: vi.fn().mockResolvedValue([INVITE]),
		});
		const res = await handleTeamInvite(
			makeRequest('GET', 'https://hoursmith.io/api/team/invites', { authorization: 'Bearer ok' }),
			{ admin, verifyJwt: vi.fn().mockResolvedValue('user-1') },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.invites).toHaveLength(1);
		expect(body.invites[0].email).toBe('newuser@test.com');
	});
});
