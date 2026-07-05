import { useEffect, useRef } from 'react';
import { getProxyOverrideState } from '../../services/proxyUrlBridge';
import {
	buildMemberStates,
	fetchReminderSettings,
	postReminderState,
	type ReminderMemberInput,
} from '../../services/reminderSync';
import type { TeamMemberSummary } from '../../services/teamService';

/**
 * Map the team weekly summaries to the minimal reminder shape (ADA-552).
 *
 * "Complete" mirrors the app's own on-time signal: a member is behind by what's
 * owed *so far* (`proratedGapSeconds`, ADA-477), falling back to the full-week
 * `gapSeconds`. "On leave" = nothing owed this week (full PTO/holiday), which
 * the prorated target already zeroes out — so those members are never nudged.
 * Members without an email are dropped (email is the server-side member key).
 */
export function teamMembersToReminderInputs(
	members: TeamMemberSummary[],
): ReminderMemberInput[] {
	return members
		.filter((m) => m.email?.trim().length > 0)
		.map((m) => {
			const behindSeconds = m.proratedGapSeconds ?? m.gapSeconds ?? 0;
			return {
				email: m.email,
				displayName: m.displayName,
				complete: behindSeconds <= 0,
				onLeave: (m.targetSeconds ?? 0) <= 0,
			};
		});
}

function fingerprint(inputs: ReminderMemberInput[], periodKey: string): string {
	return `${periodKey}|${inputs
		.map((m) => `${m.email}:${m.complete ? 1 : 0}:${m.onLeave ? 1 : 0}`)
		.join(',')}`;
}

/**
 * Keep the server's reminder completeness-state in sync with what the lead sees
 * in Reports, so the cron has fresh data to chase (ADA-552).
 *
 * Fires only when gated on (Hosted build + `reminders-ui` flag), the lead is
 * signed in, and the lead has opted in server-side (checked via a hydrate GET).
 * De-duped by a completeness fingerprint so it POSTs once per real change, not
 * on every render. Silent on failure — this is background upkeep, not a user
 * action.
 */
export function useReminderStateSync(
	members: TeamMemberSummary[],
	periodKey: string,
	gateOn: boolean,
): void {
	const lastSynced = useRef<string>('');

	useEffect(() => {
		if (!gateOn || members.length === 0 || !periodKey) return;
		const token = getProxyOverrideState().supabaseAccessToken;
		if (!token) return;

		const inputs = teamMembersToReminderInputs(members);
		if (inputs.length === 0) return;

		const fp = fingerprint(inputs, periodKey);
		if (fp === lastSynced.current) return;

		let cancelled = false;
		void (async () => {
			// Respect opt-in: never persist member state before the lead enables
			// reminders. One GET per fingerprint change is bounded and cheap.
			const settings = await fetchReminderSettings(token);
			if (cancelled || !settings?.enabled) return;
			const result = await postReminderState(token, {
				states: buildMemberStates(inputs, periodKey),
			});
			if (!cancelled && result.ok) lastSynced.current = fp;
		})();

		return () => {
			cancelled = true;
		};
	}, [gateOn, members, periodKey]);
}
