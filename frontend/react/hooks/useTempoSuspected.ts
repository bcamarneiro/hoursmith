import { useConfigStore } from '../../stores/useConfigStore';
import {
	buildJiraConnectionFingerprint,
	useUIStore,
} from '../../stores/useUIStore';

/**
 * Whether Tempo has been detected **for the connection currently configured**.
 *
 * The flag is persisted, which matters more than it sounds: `auto` is the
 * default mode, and an unpersisted flag resolves to Jira on every cold load
 * until a read completes. A write in that window — logging from a suggestion or
 * a day card before the first month read resolves — goes to Jira natively on a
 * Tempo-managed instance, which is the invisible-or-double-counted worklog the
 * write router exists to prevent.
 *
 * It is scoped by connection fingerprint because persistence introduces the
 * opposite risk: pointing Settings at a different Jira host would otherwise
 * inherit the previous instance's suspicion and route everything to a Tempo
 * that host does not use.
 */
export function useTempoSuspected(): boolean {
	const suspected = useUIStore((s) => s.tempoSuspected);
	const suspectedFingerprint = useUIStore((s) => s.tempoSuspectedFingerprint);
	const jiraHost = useConfigStore((s) => s.config.jiraHost);
	const email = useConfigStore((s) => s.config.email);
	const apiToken = useConfigStore((s) => s.config.apiToken);
	const corsProxy = useConfigStore((s) => s.config.corsProxy);

	if (!suspected) return false;
	// A suspicion with no recorded connection predates this scoping; trust it
	// for the session rather than discarding a correct detection.
	if (!suspectedFingerprint) return true;
	return (
		suspectedFingerprint ===
		buildJiraConnectionFingerprint({ jiraHost, email, apiToken, corsProxy })
	);
}
