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

export interface ReminderStatePayload {
	settings: ReminderLocalSettings;
	states: Array<{
		memberEmail: string;
		displayName: string;
		periodKey: string;
		complete: boolean;
		onLeave: boolean;
	}>;
}

/**
 * Build the sync payload. Pure — no network, no auth — so it's trivially
 * testable and the network layer stays a thin wrapper. Members without an
 * email are dropped (the email is the server-side member key).
 */
export function buildReminderStatePayload(
	settings: ReminderLocalSettings,
	members: ReminderMemberInput[],
	periodKey: string,
): ReminderStatePayload {
	return {
		settings,
		states: members
			.filter((m) => m.email.trim().length > 0)
			.map((m) => ({
				memberEmail: m.email,
				displayName: m.displayName,
				periodKey,
				complete: m.complete,
				onLeave: m.onLeave,
			})),
	};
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
