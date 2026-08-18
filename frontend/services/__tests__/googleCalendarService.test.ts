import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarMapping } from '../../stores/useUserDataStore';
import {
	buildGoogleAuthUrl,
	exchangeCodeForTokens,
	fetchGoogleCalendarSuggestions,
	generateCodeChallenge,
	generateCodeVerifier,
	refreshAccessToken,
	type GoogleCalendarTokens,
} from '../googleCalendarService';

// ─── PKCE Helpers ─────────────────────────────────────────────────────────────

describe('generateCodeVerifier', () => {
	it('returns a base64url-encoded string of 32 bytes', () => {
		const verifier = generateCodeVerifier();
		// base64url: alphanumeric + - and _, no padding
		expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
		// 32 bytes → ~43 base64url chars
		expect(verifier.length).toBeGreaterThanOrEqual(40);
		expect(verifier.length).toBeLessThanOrEqual(45);
	});

	it('generates a different verifier on each call', () => {
		const v1 = generateCodeVerifier();
		const v2 = generateCodeVerifier();
		expect(v1).not.toBe(v2);
	});
});

describe('generateCodeChallenge', () => {
	it('produces a valid base64url code challenge from a verifier', async () => {
		const verifier = generateCodeVerifier();
		const challenge = await generateCodeChallenge(verifier);
		// SHA-256 → 32 bytes → ~43 base64url chars
		expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge.length).toBeGreaterThanOrEqual(40);
		expect(challenge.length).toBeLessThanOrEqual(45);
	});

	it('is deterministic for the same input', async () => {
		const verifier = 'test_verifier_for_determinism_check_12345678';
		const c1 = await generateCodeChallenge(verifier);
		const c2 = await generateCodeChallenge(verifier);
		expect(c1).toBe(c2);
	});
});

describe('buildGoogleAuthUrl', () => {
	const clientId = 'test-client-id.apps.googleusercontent.com';
	const redirectUri = 'https://app.hoursmith.com/callback';
	const codeChallenge = 'test_challenge_123';

	it('builds a valid Google OAuth URL with PKCE parameters', () => {
		const url = buildGoogleAuthUrl(clientId, redirectUri, codeChallenge);
		expect(url).toMatch(/^https:\/\/.+?\.google\.com\/.+?auth/);
		expect(url).toContain(`client_id=${clientId}`);
		expect(url).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
		expect(url).toContain('response_type=code');
		expect(url).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly');
		expect(url).toContain('access_type=offline');
		expect(url).toContain('prompt=consent');
		expect(url).toContain(`code_challenge=${codeChallenge}`);
		expect(url).toContain('code_challenge_method=S256');
		expect(url).toContain('include_granted_scopes=true');
	});
});

// ─── Token Exchange ───────────────────────────────────────────────────────────

describe('exchangeCodeForTokens', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('exchanges an auth code for access and refresh tokens', async () => {
		const mockResponse = {
			access_token: 'mock_access_token',
			expires_in: 3599,
			refresh_token: 'mock_refresh_token',
			token_type: 'Bearer',
		};

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse,
		} as Response);

		const tokens = await exchangeCodeForTokens(
			'auth_code_123',
			'client_id_123',
			'https://app.hoursmith.com/callback',
			'verifier_123',
		);

		expect(tokens.accessToken).toBe('mock_access_token');
		expect(tokens.refreshToken).toBe('mock_refresh_token');
		expect(tokens.expiresAt).toBeTypeOf('number');
		expect(tokens.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	it('throws on HTTP error', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
		} as Response);

		await expect(
			exchangeCodeForTokens('bad_code', 'client_id', 'redirect', 'verifier'),
		).rejects.toThrow();
	});

	it('throws if access_token is missing in response', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ refresh_token: 'only_refresh' }),
		} as Response);

		await expect(
			exchangeCodeForTokens('code', 'client_id', 'redirect', 'verifier'),
		).rejects.toThrow(/missing tokens/);
	});

	it('throws if refresh_token is missing in response', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ access_token: 'only_access' }),
		} as Response);

		await expect(
			exchangeCodeForTokens('code', 'client_id', 'redirect', 'verifier'),
		).rejects.toThrow(/missing tokens/);
	});
});

// ─── Token Refresh ────────────────────────────────────────────────────────────

describe('refreshAccessToken', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('refreshes an access token using a refresh token', async () => {
		const mockResponse = {
			access_token: 'new_access_token',
			expires_in: 3599,
			refresh_token: 'new_refresh_token',
			token_type: 'Bearer',
		};

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse,
		} as Response);

		const tokens = await refreshAccessToken('client_id_123', 'refresh_token_123');

		expect(tokens.accessToken).toBe('new_access_token');
		expect(tokens.refreshToken).toBe('new_refresh_token');
		expect(tokens.expiresAt).toBeTypeOf('number');
	});

	it('preserves the old refresh token if a new one is not returned', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'new_access',
				expires_in: 3599,
			}),
		} as Response);

		const tokens = await refreshAccessToken('client_id', 'old_refresh_token');
		expect(tokens.refreshToken).toBe('old_refresh_token');
	});

	it('uses the CORS proxy when provided', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: 'new_access',
				expires_in: 3599,
				refresh_token: 'new_refresh',
			}),
		} as Response);

		await refreshAccessToken('client_id', 'refresh_token', 'https://proxy.example.com');

		const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(callArgs[0] as string).toMatch(/^https:\/\/proxy\.example\.com\//);
	});

	it('throws on HTTP error', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
		} as Response);

		await expect(
			refreshAccessToken('client_id', 'bad_refresh_token'),
		).rejects.toThrow();
	});
});

// ─── Main Suggestion Fetching ─────────────────────────────────────────────────

describe('fetchGoogleCalendarSuggestions', () => {
	const originalFetch = global.fetch;

	const validTokens: GoogleCalendarTokens = {
		accessToken: 'valid_access_token',
		refreshToken: 'valid_refresh_token',
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
	};

	beforeEach(() => {
		vi.spyOn(Math, 'random').mockReturnValue(0.123456);
	});

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	const mockEventsResponse = {
		ok: true,
		json: async () => ({
			items: [
				{
					id: 'event_1',
					summary: 'ADA-100 Team Sync',
					start: { dateTime: '2026-06-10T10:00:00-03:00' },
					end: { dateTime: '2026-06-10T11:00:00-03:00' },
					attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
				},
				{
					id: 'event_2',
					summary: 'ADA-200 Pair Programming',
					start: { dateTime: '2026-06-10T14:00:00-03:00' },
					end: { dateTime: '2026-06-10T16:00:00-03:00' },
					attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
				},
			],
		}),
	} as Response;

	it('fetches events and returns mapped suggestions', async () => {
		global.fetch = vi.fn().mockResolvedValue(mockEventsResponse);

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(result.suggestions).toHaveLength(2);
		expect(result.suggestions[0].issueKey).toBe('ADA-100');
		expect(result.suggestions[1].issueKey).toBe('ADA-200');
		expect(result.updatedTokens).toBe(validTokens);
	});

	it('filters out declined events', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				items: [
					{
						id: 'event_accepted',
						summary: 'ADA-100 Accepted Meeting',
						start: { dateTime: '2026-06-10T10:00:00-03:00' },
						end: { dateTime: '2026-06-10T11:00:00-03:00' },
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
					},
					{
						id: 'event_declined',
						summary: 'ADA-200 Declined Meeting',
						start: { dateTime: '2026-06-10T14:00:00-03:00' },
						end: { dateTime: '2026-06-10T15:00:00-03:00' },
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'declined' }],
					},
				],
			}),
		} as Response);

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].issueKey).toBe('ADA-100');
	});

	it('includes personal events with no attendees', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				items: [
					{
						id: 'personal_event',
						summary: 'ADA-100 Deep Work',
						start: { dateTime: '2026-06-10T09:00:00-03:00' },
						end: { dateTime: '2026-06-10T11:00:00-03:00' },
					},
				],
			}),
		} as Response);

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].issueKey).toBe('ADA-100');
	});

	it('includes events where user is organizer', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				items: [
					{
						id: 'organizer_event',
						summary: 'ADA-100 Team Standup',
						start: { dateTime: '2026-06-10T09:00:00-03:00' },
						end: { dateTime: '2026-06-10T09:30:00-03:00' },
						organizer: { email: 'user@example.com', self: true },
						attendees: [{ email: 'other@example.com', responseStatus: 'accepted' }],
					},
				],
			}),
		} as Response);

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].issueKey).toBe('ADA-100');
	});

	it('skips all-day events', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				items: [
					{
						id: 'all_day_event',
						summary: 'Company Holiday',
						start: { date: '2026-06-10' },
						end: { date: '2026-06-11' },
						status: 'confirmed',
					},
					{
						id: 'timed_event',
						summary: 'ADA-100 Meeting',
						start: { dateTime: '2026-06-10T10:00:00-03:00' },
						end: { dateTime: '2026-06-10T11:00:00-03:00' },
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
					},
				],
			}),
		} as Response);

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].issueKey).toBe('ADA-100');
	});

	it('uses calendar mappings when no inline Jira key is found', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				items: [
					{
						id: 'mapped_event',
						summary: 'Sprint Planning',
						description: 'Weekly sprint planning session',
						start: { dateTime: '2026-06-10T10:00:00-03:00' },
						end: { dateTime: '2026-06-10T11:00:00-03:00' },
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
					},
				],
			}),
		} as Response);

		const mappings: CalendarMapping[] = [
			{
				issueKey: 'PROJ-123',
				patterns: ['sprint planning', 'weekly sprint'],
			},
		];

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			mappings,
		);

		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].issueKey).toBe('PROJ-123');
	});

	it('returns unmapped events with empty issueKey for manual mapping', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				items: [
					{
						id: 'unmapped_event',
						summary: 'Coffee Chat',
						start: { dateTime: '2026-06-10T15:00:00-03:00' },
						end: { dateTime: '2026-06-10T15:30:00-03:00' },
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
					},
				],
			}),
		} as Response);

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].issueKey).toBe('');
		expect(result.suggestions[0].calendarEventTitle).toBe('Coffee Chat');
		expect(result.suggestions[0].confidence).toBe('low');
	});

	it('respects abort signal', async () => {
		const abortController = new AbortController();
		abortController.abort();

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
			abortController.signal,
		);

		expect(result.suggestions).toHaveLength(0);
	});

	it('caps single event duration at 4 hours', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				items: [
					{
						id: 'long_event',
						summary: 'ADA-100 All Day Workshop',
						start: { dateTime: '2026-06-10T09:00:00-03:00' },
						end: { dateTime: '2026-06-10T17:00:00-03:00' }, // 8 hours
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
					},
				],
			}),
		} as Response);

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(result.suggestions).toHaveLength(1);
		// 8 hours should be capped to 4 hours
		expect(result.suggestions[0].suggestedTimeSpent).toBe('4h');
	});

	it('sets minimum duration to 15 minutes', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				items: [
					{
						id: 'short_event',
						summary: 'ADA-100 Quick Sync',
						start: { dateTime: '2026-06-10T10:00:00-03:00' },
						end: { dateTime: '2026-06-10T10:05:00-03:00' }, // 5 minutes
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
					},
				],
			}),
		} as Response);

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(result.suggestions).toHaveLength(1);
		// 5 minutes should be bumped to minimum duration
		expect(result.suggestions[0].suggestedTimeSpent).toBe('30m');
	});

	it('groups multiple events on same day for same issue', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				items: [
					{
						id: 'event_1',
						summary: 'ADA-100 Morning Standup',
						start: { dateTime: '2026-06-10T09:00:00-03:00' },
						end: { dateTime: '2026-06-10T09:30:00-03:00' },
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
					},
					{
						id: 'event_2',
						summary: 'ADA-100 Afternoon Review',
						start: { dateTime: '2026-06-10T15:00:00-03:00' },
						end: { dateTime: '2026-06-10T16:00:00-03:00' },
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
					},
				],
			}),
		} as Response);

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		// Should be grouped into one suggestion
		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].reason).toContain('Morning Standup');
		expect(result.suggestions[0].reason).toContain('Afternoon Review');
		expect(result.suggestions[0].confidence).toBe('high');
	});

	it('skips events outside the date range', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				items: [
					{
						id: 'out_of_range_event',
						summary: 'ADA-100 Out of Range',
						start: { dateTime: '2026-06-01T10:00:00-03:00' }, // Before week start
						end: { dateTime: '2026-06-01T11:00:00-03:00' },
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
					},
					{
						id: 'in_range_event',
						summary: 'ADA-200 In Range',
						start: { dateTime: '2026-06-10T10:00:00-03:00' },
						end: { dateTime: '2026-06-10T11:00:00-03:00' },
						attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
					},
				],
			}),
		} as Response);

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			validTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0].issueKey).toBe('ADA-200');
	});

	it('refreshes token if expired during fetch and returns updated tokens', async () => {
		const nearExpiredTokens: GoogleCalendarTokens = {
			accessToken: 'nearly_expired_access',
			refreshToken: 'valid_refresh',
			expiresAt: Math.floor(Date.now() / 1000) - 10,
		};

		let callCount = 0;
		global.fetch = vi.fn().mockImplementation((url: string) => {
			callCount++;
			if (url.includes('/token')) {
				return Promise.resolve({
					ok: true,
					json: async () => ({
						access_token: 'refreshed_access',
						expires_in: 3599,
						refresh_token: 'new_refresh',
					}),
				} as Response);
			} else {
				return Promise.resolve({
					ok: true,
					json: async () => ({
						items: [
							{
								id: 'event_1',
								summary: 'ADA-100 Meeting',
								start: { dateTime: '2026-06-10T10:00:00-03:00' },
								end: { dateTime: '2026-06-10T11:00:00-03:00' },
								attendees: [{ email: 'user@example.com', self: true, responseStatus: 'accepted' }],
							},
						],
					}),
				} as Response);
			}
		});

		const result = await fetchGoogleCalendarSuggestions(
			'client_id_123',
			nearExpiredTokens,
			'',
			'2026-06-08',
			'2026-06-14',
			[],
		);

		expect(result.suggestions).toHaveLength(1);
		expect(result.updatedTokens.accessToken).toBe('refreshed_access');
		expect(result.updatedTokens.refreshToken).toBe('new_refresh');
		expect(callCount).toBe(2);
	});
});
