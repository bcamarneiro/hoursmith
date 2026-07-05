import { useEffect, useState } from 'react';
import { isFeatureEnabled, onFeatureFlags } from '../../analytics';

/**
 * Subscribe a component to a PostHog feature flag (ADA-552).
 *
 * Re-renders when flags load or change. Returns `fallback` until PostHog has
 * loaded flags (or forever, if analytics is disabled / opted out) — so a
 * flag-gated feature renders in its safe default state (usually hidden) rather
 * than flickering on.
 *
 * Exposure only — pair it with `isPremiumBuild()` for capability and with the
 * server's entitlement check for authorization. Never the sole gate on anything
 * security-sensitive.
 */
export function useFeatureFlag(flag: string, fallback = false): boolean {
	const [enabled, setEnabled] = useState(() =>
		isFeatureEnabled(flag, fallback),
	);

	useEffect(() => {
		// Re-read on mount (the SDK may have loaded flags between initial render
		// and effect), then stay subscribed to later (re)loads.
		setEnabled(isFeatureEnabled(flag, fallback));
		return onFeatureFlags(() => setEnabled(isFeatureEnabled(flag, fallback)));
	}, [flag, fallback]);

	return enabled;
}
