/**
 * Client → server sync for reminder state (ADA-552).
 *
 * The lead's browser already computes per-member completeness for the current
 * period. This module turns that into the MINIMAL payload the server stores —
 * a complete flag + leave flag per member, plus the team's reminder settings —
 * and POSTs it to `/api/reminders/state`. Never hours, never issue keys: the
 * privacy promise is enforced by the shape of what leaves the client.
 *
 * `owner_user_id` is never sent; the server derives it from the verified JWT,
 * so a member row can only ever be written under the authenticated lead.
 */

export interface ReminderLocalSettings {
	enabled: boolean;
	memberNudge: boolean;
	leadDigest: boolean;
	leadEmail?: string;
	teamName?: string;
}

/** One roster member's completeness for the period, as the client sees it. */
export interface ReminderMemberInput {
	email: string;
	displayName: string;
	complete: boolean;
	onLeave: boolean;
}

export interface ReminderStateEntry {
	memberEmail: string;
	displayName: string;
	periodKey: string;
	complete: boolean;
	onLeave: boolean;
}

/**
 * The two callers send disjoint halves and the endpoint upserts each
 * independently, so both fields are optional: the Settings panel posts
 * `{ settings }`, the Reports view posts `{ states }`. A partial body never
 * wipes the other half.
 */
export interface ReminderStatePayload {
	settings?: ReminderLocalSettings;
	states?: ReminderStateEntry[];
}

/** Map roster completeness to the minimal per-member state (Reports caller). */
export function buildMemberStates(
	members: ReminderMemberInput[],
	periodKey: string,
): ReminderStateEntry[] {
	return members
		.filter((m) => m.email.trim().length > 0)
		.map((m) => ({
			memberEmail: m.email,
			displayName: m.displayName,
			periodKey,
			complete: m.complete,
			onLeave: m.onLeave,
		}));
}

/** Hydrate the Settings panel with the lead's saved config. Returns null on any
 * failure (unauthenticated, offline, server error) — the panel then shows its
 * defaults rather than blocking. */
export async function fetchReminderSettings(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ReminderLocalSettings | null> {
	try {
		const res = await fetchImpl('/api/reminders/state', {
			method: 'GET',
			headers: { authorization: `Bearer ${accessToken}` },
		});
		if (!res.ok) return null;
		const parsed = (await res.json()) as { settings?: ReminderLocalSettings };
		return parsed?.settings ?? null;
	} catch {
		return null;
	}
}

export interface PostReminderStateResult {
	ok: boolean;
	status: number;
	error?: string;
}

/**
 * POST the payload with the caller's Supabase access token. Injectable `fetch`
 * for tests. Never throws on an HTTP error — returns a typed result the caller
 * can surface as a toast.
 */
export async function postReminderState(
	accessToken: string,
	payload: ReminderStatePayload,
	fetchImpl: typeof fetch = fetch,
): Promise<PostReminderStateResult> {
	try {
		const res = await fetchImpl('/api/reminders/state', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${accessToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			let code = `http_${res.status}`;
			try {
				const parsed = (await res.json()) as { error?: string };
				if (parsed?.error) code = parsed.error;
			} catch {
				// non-JSON error body — keep the http_<status> code
			}
			return { ok: false, status: res.status, error: code };
		}
		return { ok: true, status: res.status };
	} catch (err) {
		return { ok: false, status: 0, error: (err as Error).message };
	}
}
