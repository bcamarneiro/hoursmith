import { useConfigStore } from '../../stores/useConfigStore';
import { buildTempoInstanceKey, useUIStore } from '../../stores/useUIStore';

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
 * It is scoped by *instance* (host + email) because persistence introduces the
 * opposite risk: pointing Settings at a different Jira host would otherwise
 * inherit the previous instance's suspicion and route everything to a Tempo
 * that host does not use. The proxy is excluded on purpose — it differs between
 * code paths (`useEffectiveProxyUrl` vs the raw config), so including it made
 * the recorded and compared keys disagree for hosted users.
 */
export function useTempoSuspected(): boolean {
	const suspected = useUIStore((s) => s.tempoSuspected);
	const suspectedFingerprint = useUIStore((s) => s.tempoSuspectedFingerprint);
	const jiraHost = useConfigStore((s) => s.config.jiraHost);
	const email = useConfigStore((s) => s.config.email);

	if (!suspected) return false;
	// No recorded instance means the suspicion cannot be scoped, so it is not
	// trusted — it would otherwise apply to whatever Jira is configured next.
	if (!suspectedFingerprint) return false;
	return suspectedFingerprint === buildTempoInstanceKey({ jiraHost, email });
}
