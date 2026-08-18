import type { WorklogSuggestion } from '../../types/Suggestion';
import { toLocalDateString } from '../react/utils/date';
import { logger } from '../react/utils/logger';
import type { CalendarMapping } from '../stores/useUserDataStore';
import { fromHttpResponse } from './serviceErrors';

const JIRA_KEY_RE = /([A-Z][A-Z0-9]+-\d+)/g;
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';

/**
 * Google Calendar OAuth tokens stored in the config store.
 * The access token is short-lived (~1h); the refresh token persists
 * across sessions. The client ID is a public OAuth 2.0 client (SPA).
 */
export interface GoogleCalendarTokens {
	accessToken: string;
	refreshToken: string;
	/** Unix timestamp (seconds) when the access token expires */
	expiresAt: number;
}

/**
 * A Google Calendar event as returned by the events.list API.
 * Only the fields we consume are typed; the API returns more.
 */
interface GoogleCalendarEvent {
	id: string;
	summary?: string;
	description?: string;
	start?: { dateTime?: string; date?: string; timeZone?: string };
	end?: { dateTime?: string; date?: string; timeZone?: string };
	status?: string;
	recurrence?: string[];
	attendees?: GoogleCalendarAttendee[];
	organizer?: { email?: string; self?: boolean };
}

interface GoogleCalendarAttendee {
	email: string;
	self?: boolean;
	responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
}

interface GoogleEventsListResponse {
	items?: GoogleCalendarEvent[];
	nextPageToken?: string;
}

interface TokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	token_type: string;
}

function _isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === 'AbortError') ||
		(error instanceof Error && error.name === 'AbortError')
	);
}

function extractJiraKeys(text: string): string[] {
	const matches = text.match(JIRA_KEY_RE);
	return matches ? [...new Set(matches)] : [];
}

/**
 * Find issue key from stored calendar mappings.
 * Returns the first mapping whose pattern matches the event summary
 * (case-insensitive substring match).
 */
function findMappedIssueKey(
	summary: string,
	mappings: CalendarMapping[],
): CalendarMapping | null {
	const lower = summary.toLowerCase();
	for (const mapping of mappings) {
		for (const pattern of mapping.patterns) {
			if (pattern && lower.includes(pattern.toLowerCase())) {
				return mapping;
			}
		}
	}
	return null;
}

// ─── PKCE OAuth Flow ────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random code verifier for PKCE.
 * Uses the Web Crypto API (available in all modern browsers).
 */
export function generateCodeVerifier(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return base64UrlEncode(array);
}

/**
 * Generate the code challenge from a verifier (S256 method).
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return base64UrlEncode(new Uint8Array(hash));
}

function base64UrlEncode(buffer: Uint8Array): string {
	let binary = '';
	for (const byte of buffer) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build the Google OAuth 2.0 authorization URL with PKCE.
 * The user is redirected here to grant calendar.readonly access.
 */
export function buildGoogleAuthUrl(
	clientId: string,
	redirectUri: string,
	codeChallenge: string,
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: SCOPES,
		access_type: 'offline',
		prompt: 'consent',
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		include_granted_scopes: 'true',
	});
	return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * This is a CORS-enabled endpoint (Google's token endpoint supports it).
 */
export async function exchangeCodeForTokens(
	code: string,
	clientId: string,
	redirectUri: string,
	codeVerifier: string,
): Promise<GoogleCalendarTokens> {
	const body = new URLSearchParams({
		code,
		client_id: clientId,
		redirect_uri: redirectUri,
		grant_type: 'authorization_code',
		code_verifier: codeVerifier,
	});

	const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body.toString(),
	});

	if (!res.ok) {
		throw fromHttpResponse('Google Calendar OAuth', res.status);
	}

	const data: TokenResponse = await res.json();
	if (!data.access_token || !data.refresh_token) {
		throw new Error('Google Calendar OAuth: missing tokens in response');
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
	};
}

/**
 * Refresh an expired access token using the refresh token.
 * Google's token endpoint is CORS-enabled, so this works browser-only.
 * If a corsProxy is configured, route through it for environments
 * where direct Google API access is blocked.
 */
export async function refreshAccessToken(
	clientId: string,
	refreshToken: string,
	corsProxy?: string,
): Promise<GoogleCalendarTokens> {
	const body = new URLSearchParams({
		client_id: clientId,
		refresh_token: refreshToken,
		grant_type: 'refresh_token',
	});

	const url = corsProxy
		? `${corsProxy.replace(/\/$/, '')}/${GOOGLE_TOKEN_ENDPOINT}`
		: GOOGLE_TOKEN_ENDPOINT;

	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body.toString(),
	});

	if (!res.ok) {
		throw fromHttpResponse('Google Calendar token refresh', res.status);
	}

	const data: TokenResponse = await res.json();
	if (!data.access_token) {
		throw new Error('Google Calendar: refresh returned no access token');
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token || refreshToken,
		expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
	};
}

// ─── Event Fetching ─────────────────────────────────────────────────────────

/**
 * Ensure the access token is fresh, refreshing if needed.
 * Returns the (possibly updated) tokens.
 */
export async function ensureValidToken(
	clientId: string,
	tokens: GoogleCalendarTokens,
	corsProxy?: string,
): Promise<GoogleCalendarTokens> {
	// 60-second buffer before actual expiry
	if (tokens.expiresAt > Math.floor(Date.now() / 1000) + 60) {
		return tokens;
	}
	return refreshAccessToken(clientId, tokens.refreshToken, corsProxy);
}

/**
 * Fetch calendar events from Google Calendar API for the given date range.
 * Only returns events where the current user's response status is 'accepted'.
 * Paginates through all results.
 */
async function fetchGoogleCalendarEvents(
	accessToken: string,
	weekStart: string,
	weekEnd: string,
	corsProxy: string,
	signal?: AbortSignal,
): Promise<GoogleCalendarEvent[]> {
	const timeMin = `${weekStart}T00:00:00Z`;
	const timeMax = `${weekEnd}T23:59:59Z`;

	const events: GoogleCalendarEvent[] = [];
	let pageToken: string | undefined;

	do {
		const params = new URLSearchParams({
			timeMin,
			timeMax,
			singleEvents: 'true',
			orderBy: 'startTime',
			maxResults: '250',
			...(pageToken ? { pageToken } : {}),
		});

		const baseUrl = `${GOOGLE_CALENDAR_API}/calendars/primary/events?${params.toString()}`;
		const url = corsProxy
			? `${corsProxy.replace(/\/$/, '')}/${baseUrl}`
			: baseUrl;

		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal,
		});

		if (!res.ok) {
			throw fromHttpResponse('Google Calendar', res.status);
		}

		const data: GoogleEventsListResponse = await res.json();
		if (data.items) {
			events.push(...data.items);
		}
		pageToken = data.nextPageToken;
	} while (pageToken);

	return events;
}

/**
 * Check if the current user accepted this event.
 * Returns true if:
 * - The user has an attendee entry with responseStatus 'accepted'
 * - The user is the organizer (implicit acceptance)
 * - There are no attendees at all (personal events, no RSVP required)
 */
function isAcceptedEvent(event: GoogleCalendarEvent): boolean {
	// No attendees → personal event, treat as attended
	if (!event.attendees || event.attendees.length === 0) {
		return true;
	}

	// Check if user is organizer (implicit acceptance)
	if (event.organizer?.self) {
		return true;
	}

	// Find the self attendee entry
	const selfAttendee = event.attendees.find((a) => a.self);
	if (!selfAttendee) {
		// No self entry → user wasn't invited, skip
		return false;
	}

	return selfAttendee.responseStatus === 'accepted';
}

/**
 * Parse a Google Calendar datetime into an ISO date string and Date.
 * Handles both dateTime (timed events) and date (all-day events).
 */
function parseGoogleDateTime(
	dt: { dateTime?: string; date?: string } | undefined,
): { iso: string; date: Date } | null {
	if (!dt) return null;

	if (dt.dateTime) {
		const d = new Date(dt.dateTime);
		if (Number.isNaN(d.getTime())) return null;
		return { iso: toLocalDateString(d), date: d };
	}

	if (dt.date) {
		// All-day event: YYYY-MM-DD
		const d = new Date(`${dt.date}T00:00:00`);
		if (Number.isNaN(d.getTime())) return null;
		return { iso: dt.date, date: d };
	}

	return null;
}

interface GroupedEvent {
	totalSeconds: number;
	reasons: string[];
	eventCount: number;
}

/**
 * Fetch Google Calendar events and build worklog suggestions.
 *
 * Only events the user accepted are included. Events are resolved in order:
 * 1. Jira keys found in event title/description (inline keys)
 * 2. Stored calendar mappings (pattern → issueKey)
 * 3. Unmapped events: returned with empty issueKey so the UI can show
 *    a "Map to Issue" action
 *
 * Returns { suggestions, updatedTokens } where updatedTokens may have a
 * refreshed access token if the original was near expiry.
 */
export async function fetchGoogleCalendarSuggestions(
	clientId: string,
	tokens: GoogleCalendarTokens,
	corsProxy: string,
	weekStart: string,
	weekEnd: string,
	mappings: CalendarMapping[],
	signal?: AbortSignal,
): Promise<{
	suggestions: WorklogSuggestion[];
	updatedTokens: GoogleCalendarTokens;
}> {
	// Ensure token is fresh
	const updatedTokens = await ensureValidToken(clientId, tokens, corsProxy);

	if (signal?.aborted) {
		return { suggestions: [], updatedTokens };
	}

	// Fetch events
	const events = await fetchGoogleCalendarEvents(
		updatedTokens.accessToken,
		weekStart,
		weekEnd,
		corsProxy,
		signal,
	);

	logger.debug(
		`[GoogleCalendar] Fetched ${events.length} events for ${weekStart} → ${weekEnd}`,
	);

	// Filter to accepted events only
	const acceptedEvents = events.filter(isAcceptedEvent);
	const declinedCount = events.length - acceptedEvents.length;

	logger.debug(
		`[GoogleCalendar] ${acceptedEvents.length} accepted, ${declinedCount} declined/tentative/needsAction filtered out`,
	);

	if (signal?.aborted) {
		return { suggestions: [], updatedTokens };
	}

	// Group events into suggestions (same logic as ICS calendar service)
	const grouped = new Map<string, GroupedEvent>();
	const unmapped = new Map<string, GroupedEvent>();

	let skippedAllDay = 0;
	let skippedOutOfRange = 0;

	for (const event of acceptedEvents) {
		const start = parseGoogleDateTime(event.start);
		const end = parseGoogleDateTime(event.end);
		if (!start) continue;

		const day = start.iso;
		if (day < weekStart || day > weekEnd) {
			skippedOutOfRange++;
			continue;
		}

		// Skip all-day events (likely OOO, holidays, birthdays)
		const isAllDay = !event.start?.dateTime;
		if (isAllDay) {
			skippedAllDay++;
			continue;
		}

		// Duration in seconds
		let durationSeconds = 0;
		if (end) {
			durationSeconds = Math.max(
				0,
				(end.date.getTime() - start.date.getTime()) / 1000,
			);
		}
		// Cap single event at 4h, min 15m
		durationSeconds = Math.max(900, Math.min(durationSeconds, 4 * 3600));

		const summary = event.summary || '';
		const description = event.description || '';
		const allText = `${summary} ${description}`;

		// 1. Try inline Jira keys
		const inlineKeys = extractJiraKeys(allText);
		if (inlineKeys.length > 0) {
			for (const key of inlineKeys) {
				const mapKey = `${day}::${key}`;
				const existing = grouped.get(mapKey) || {
					totalSeconds: 0,
					reasons: [],
					eventCount: 0,
				};
				existing.totalSeconds += durationSeconds;
				existing.eventCount++;
				existing.reasons.push(summary.slice(0, 60));
				grouped.set(mapKey, existing);
			}
			continue;
		}

		// 2. Try stored mappings
		const mapping = findMappedIssueKey(summary, mappings);
		if (mapping) {
			const mapKey = `${day}::${mapping.issueKey}`;
			const existing = grouped.get(mapKey) || {
				totalSeconds: 0,
				reasons: [],
				eventCount: 0,
			};
			existing.totalSeconds += durationSeconds;
			existing.eventCount++;
			existing.reasons.push(summary.slice(0, 60));
			grouped.set(mapKey, existing);
			continue;
		}

		// 3. Unmapped event
		const title = summary.trim();
		if (!title) continue;

		const unmappedKey = `${day}::${title}`;
		const existingUnmapped = unmapped.get(unmappedKey) || {
			totalSeconds: 0,
			reasons: [],
			eventCount: 0,
		};
		existingUnmapped.totalSeconds += durationSeconds;
		existingUnmapped.eventCount++;
		existingUnmapped.reasons.push(title.slice(0, 60));
		unmapped.set(unmappedKey, existingUnmapped);
	}

	const suggestions: WorklogSuggestion[] = [];

	// Build mapped suggestions
	for (const [mapKey, data] of grouped) {
		const [day, issueKey] = mapKey.split('::');
		const cappedSeconds = Math.min(data.totalSeconds, 6 * 3600);
		const hours = cappedSeconds / 3600;

		suggestions.push({
			id: `gcal-${issueKey}-${day}`,
			source: 'calendar',
			issueKey,
			date: day,
			suggestedTimeSpent:
				hours >= 1
					? `${Math.floor(hours)}h${hours % 1 >= 0.5 ? ' 30m' : ''}`
					: '30m',
			suggestedSeconds: cappedSeconds,
			confidence: data.eventCount >= 2 ? 'high' : 'medium',
			reason: `${data.eventCount} meeting${data.eventCount > 1 ? 's' : ''}: ${data.reasons.slice(0, 2).join('; ')}${data.reasons.length > 2 ? '...' : ''}`,
			logged: false,
		});
	}

	// Build unmapped suggestions
	for (const [mapKey, data] of unmapped) {
		const [day] = mapKey.split('::');
		const cappedSeconds = Math.min(data.totalSeconds, 6 * 3600);
		const hours = cappedSeconds / 3600;
		const title = data.reasons[0] || 'Unknown event';

		suggestions.push({
			id: `gcal-unmapped-${day}-${title.slice(0, 30).replace(/\\s+/g, '-').toLowerCase()}`,
			source: 'calendar',
			issueKey: '',
			date: day,
			suggestedTimeSpent:
				hours >= 1
					? `${Math.floor(hours)}h${hours % 1 >= 0.5 ? ' 30m' : ''}`
					: '30m',
			suggestedSeconds: cappedSeconds,
			confidence: 'low',
			reason: `${data.eventCount} meeting${data.eventCount > 1 ? 's' : ''}: ${data.reasons.slice(0, 2).join('; ')}${data.reasons.length > 2 ? '...' : ''}`,
			logged: false,
			calendarEventTitle: title,
		});
	}

	logger.debug(
		`[GoogleCalendar] ${acceptedEvents.length} accepted events → ${grouped.size} mapped + ${unmapped.size} unmapped = ${suggestions.length} suggestions (${skippedAllDay} all-day skipped, ${skippedOutOfRange} out-of-range)`,
	);

	return { suggestions, updatedTokens };
}
