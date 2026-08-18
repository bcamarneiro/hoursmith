/**
 * Calendar date-list integration trigger (ADA-627).
 *
 * Fire-and-forget call to the premium `/api/calendartrigger` endpoint.
 * Reads the Supabase access token from the proxy bridge synchronously
 * (covers cold-load scenarios the same way the hosted proxy does).
 *
 * Failures are intentionally silent — the trigger is an audit/analytics
 * side-effect with no user-facing consequences.
 */

import { getProxyOverrideState } from './proxyUrlBridge';

const ENDPOINT = '/api/calendartrigger';

/**
 * Notify the backend that a calendar date-list has been successfully
 * integrated into the current dashboard session. This is a one-shot
 * fire-and-forget side-effect — the promise is deliberately not
 * awaited in callers.
 */
export function triggerCalendarDateListIntegration(): void {
	const token = getProxyOverrideState().supabaseAccessToken;
	if (!token) return; // anonymous or not premium — nothing to trigger

	const controller = new AbortController();
	// Hard time-out — we don't want a stuck request lingering
	setTimeout(() => controller.abort(), 8_000);

	fetch(ENDPOINT, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		signal: controller.signal,
	}).catch(() => {
		// Silent — the trigger is best-effort
	});
}
