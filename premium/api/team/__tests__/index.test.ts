/**
 * Unit tests for team accounts API (ADA-489).
 *
 * POST /api/team — Create a team
 * GET  /api/team — Get caller's team
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseAdminClient } from '../../_lib/supabaseAdmin';
import { handleTeam } from '../index';

function makeRequest(
	method: string,
	headers: Record<string, string> = {},
	body?: unknown,
): Request {
	return new Request('https://hoursmith.io/api/team', {
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
};

function makeAdmin(
	overrides: Partial<SupabaseAdminClient> = {},
): SupabaseAdminClient {
	return {
		getUserIdFromToken: vi.fn().mockResolvedValue('user-1'),
		getProfile: vi.fn(),
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
		getTeamByOwner: vi.fn().mockResolvedValue(null),
		getTeamById: vi.fn().mockResolvedValue(TEAM),
		getTeamByInviteToken: vi.fn(),
		createTeam: vi.fn().mockResolvedValue(TEAM),
		updateTeamSeatLimit: vi.fn(),
		deleteTeam: vi.fn(),
		getTeamMembers: vi.fn().mockResolvedValue([]),
		getTeamMembership: vi.fn(),
		getUserTeamMembership: vi.fn().mockResolvedValue(null),
		addTeamMember: vi.fn(),
		removeTeamMember: vi.fn(),
		updateMemberRole: vi.fn(),
		createTeamInvite: vi.fn(),
		getTeamInviteByToken: vi.fn(),
		getTeamInvites: vi.fn().mockResolvedValue([]),
		markInviteAccepted: vi.fn(),
		deleteTeamInvite: vi.fn(),
		getProfileByEmail: vi.fn(),
		...overrides,
	};
}

describe('POST /api/team', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const admin = makeAdmin();
		const res = await handleTeam(makeRequest('POST'), { admin });
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'missing_token' });
	});

	it('returns 401 when token is invalid', async () => {
		const admin = makeAdmin();
		const res = await handleTeam(makeRequest('POST'), {
			admin,
			verifyJwt: vi.fn().mockResolvedValue(null),
		});
		expect(res.status).toBe(401);
	});

	it('returns 409 when user already owns a team', async () => {
		const admin = makeAdmin({
			getTeamByOwner: vi.fn().mockResolvedValue(TEAM),
		});
		const res = await handleTeam(makeRequest('POST', { authorization: 'Bearer ok' }, { name: 'My Team' }), {
			admin,
			verifyJwt: vi.fn().mockResolvedValue('user-1'),
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'already_owns_team' });
	});

	it('returns 409 when user is already a member of a team', async () => {
		const admin = makeAdmin({
			getUserTeamMembership: vi.fn().mockResolvedValue({
				...MEMBERSHIP,
				team_name: 'Existing Team',
			}),
		});
		const res = await handleTeam(makeRequest('POST', { authorization: 'Bearer ok' }, { name: 'My Team' }), {
			admin,
			verifyJwt: vi.fn().mockResolvedValue('user-1'),
		});
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'already_in_team' });
	});

	it('returns 400 when team name is invalid', async () => {
		const admin = makeAdmin();
		const res = await handleTeam(makeRequest('POST', { authorization: 'Bearer ok' }, { name: 'x' }), {
			admin,
			verifyJwt: vi.fn().mockResolvedValue('user-1'),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_team_name' });
	});

	it('returns 400 when seat limit is out of range', async () => {
		const admin = makeAdmin();
		const res = await handleTeam(
			makeRequest('POST', { authorization: 'Bearer ok' }, { name: 'My Team', seatLimit: 1 }),
			{
				admin,
				verifyJwt: vi.fn().mockResolvedValue('user-1'),
			},
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_seat_limit' });
	});

	it('creates a team and adds the owner as first member', async () => {
		const admin = makeAdmin();
		const res = await handleTeam(
			makeRequest('POST', { authorization: 'Bearer ok' }, { name: 'My Team', seatLimit: 10 }),
			{
				admin,
				verifyJwt: vi.fn().mockResolvedValue('user-1'),
			},
		);
		expect(res.status).toBe(201);
		expect(admin.createTeam).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'My Team',
				ownerId: 'user-1',
				seatLimit: 10,
			}),
		);
		expect(admin.addTeamMember).toHaveBeenCalledWith(expect.any(String), 'user-1', 'owner');
	});

	it('defaults seat limit to 5 when not provided', async () => {
		const admin = makeAdmin();
		await handleTeam(
			makeRequest('POST', { authorization: 'Bearer ok' }, { name: 'My Team' }),
			{
				admin,
				verifyJwt: vi.fn().mockResolvedValue('user-1'),
			},
		);
		expect(admin.createTeam).toHaveBeenCalledWith(
			expect.objectContaining({ seatLimit: 5 }),
		);
	});
});

describe('GET /api/team', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const admin = makeAdmin();
		const res = await handleTeam(makeRequest('GET'), { admin });
		expect(res.status).toBe(401);
	});

	it('returns { team: null } when user is not in a team', async () => {
		const admin = makeAdmin();
		const res = await handleTeam(makeRequest('GET', { authorization: 'Bearer ok' }), {
			admin,
			verifyJwt: vi.fn().mockResolvedValue('user-1'),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ team: null });
	});

	it('returns the team with members when user is a member', async () => {
		const members = [
			{ ...MEMBERSHIP, email: 'owner@test.com' },
			{ team_id: 'team-1', user_id: 'user-2', role: 'member' as const, joined_at: '2026-01-02T00:00:00Z', email: 'member@test.com' },
		];
		const admin = makeAdmin({
			getUserTeamMembership: vi.fn().mockResolvedValue({
				...MEMBERSHIP,
				team_name: 'Test Team',
			}),
			getTeamMembers: vi.fn().mockResolvedValue(members),
		});
		const res = await handleTeam(makeRequest('GET', { authorization: 'Bearer ok' }), {
			admin,
			verifyJwt: vi.fn().mockResolvedValue('user-1'),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.team).toBeDefined();
		expect(body.team.name).toBe('Test Team');
		expect(body.team.members).toHaveLength(2);
	});

	it('returns the team when user owns it but has no membership row yet', async () => {
		const admin = makeAdmin({
			getUserTeamMembership: vi.fn().mockResolvedValue(null),
			getTeamByOwner: vi.fn().mockResolvedValue(TEAM),
			getTeamMembers: vi.fn().mockResolvedValue([]),
		});
		const res = await handleTeam(makeRequest('GET', { authorization: 'Bearer ok' }), {
			admin,
			verifyJwt: vi.fn().mockResolvedValue('user-1'),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.team).toBeDefined();
		expect(body.team.name).toBe('Test Team');
	});

	it('returns 405 for unsupported methods', async () => {
		const admin = makeAdmin();
		const res = await handleTeam(makeRequest('PUT', { authorization: 'Bearer ok' }), {
			admin,
			verifyJwt: vi.fn().mockResolvedValue('user-1'),
		});
		expect(res.status).toBe(405);
	});
});
