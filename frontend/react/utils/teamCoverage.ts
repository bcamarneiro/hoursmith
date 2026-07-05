import type { TeamMemberSummary } from '../../services/teamService';

/**
 * Coverage of the weekly team board vs. the expected roster (ADA-488).
 *
 * A completeness tool must never *silently* omit the person who matters most —
 * someone who logged 0h all week. The board is built from worklog data, so:
 *  - With a roster (`allowedUsers`) configured, every roster member is rendered
 *    even at 0h; here we surface how many have no worklogs so a permission/scope
 *    hole ("0 visibility") never reads as "everyone's compliant".
 *  - With no roster configured, the board is author-only — anyone who logged
 *    nothing is invisible — so we warn and point at Settings.
 */
export interface TeamCoverage {
	/** True when a team roster (`allowedUsers`) is configured. */
	rosterConfigured: boolean;
	/** Expected roster size. `null` when no roster is configured. */
	rosterSize: number | null;
	/** Members who logged any time this week (`totalSeconds > 0`). */
	loggedCount: number;
	/**
	 * Roster members the board expected but found no worklogs for
	 * (`max(0, rosterSize - loggedCount)`). 0 when no roster is configured.
	 */
	noWorklogCount: number;
	/**
	 * True when the coverage picture warrants a warning banner: a roster is
	 * configured but ≥1 member has no worklogs, OR no roster is configured at
	 * all (author-only board can silently omit 0h members).
	 */
	hasWarning: boolean;
}

/**
 * Split the `allowedUsers` CSV (the roster) into trimmed, non-empty entries.
 * Mirrors the store's normalisation so the count matches what the builder uses.
 */
function parseRoster(allowedUsers: string): string[] {
	return allowedUsers
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function computeTeamCoverage(
	members: Pick<TeamMemberSummary, 'totalSeconds'>[],
	allowedUsers: string,
): TeamCoverage {
	const roster = parseRoster(allowedUsers);
	const rosterConfigured = roster.length > 0;
	const loggedCount = members.filter(
		(member) => member.totalSeconds > 0,
	).length;

	if (!rosterConfigured) {
		return {
			rosterConfigured: false,
			rosterSize: null,
			loggedCount,
			noWorklogCount: 0,
			// Author-only board: a 0h member who never authored a worklog is
			// absent entirely, so always caveat it.
			hasWarning: true,
		};
	}

	const rosterSize = roster.length;
	// Expected-vs-observed: every roster member is rendered, so the ones with no
	// worklogs are the roster size minus those who logged. Clamp at 0 in case an
	// author outside the roster slipped through upstream.
	const noWorklogCount = Math.max(0, rosterSize - loggedCount);

	return {
		rosterConfigured: true,
		rosterSize,
		loggedCount,
		noWorklogCount,
		hasWarning: noWorklogCount > 0,
	};
}
