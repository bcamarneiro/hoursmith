import {
	type FetchMonthOptions,
	fetchMonthWorklogs,
} from '../../services/monthWorklogService';
import {
	fetchMonthWorklogsTempo,
	fetchTeamMonthWorklogsTempo,
} from '../../services/tempoWorklogService';
import type { WorklogReadScope } from '../../services/worklogSource';
import type { Config } from '../../stores/useConfigStore';

/**
 * `options.scope` decides which Tempo endpoint serves the read. Getting it
 * wrong is silent: the per-user endpoint answers a team read with only the
 * signed-in user's rows, so the caller sees plausible but partial data rather
 * than an error (ADA-545).
 */
export function readMonth(
	source: 'jira' | 'tempo',
	config: Config,
	year: number,
	month: number,
	options?: FetchMonthOptions & { scope?: WorklogReadScope },
	signal?: AbortSignal,
) {
	if (source !== 'tempo') {
		return fetchMonthWorklogs(config, year, month, options, signal);
	}
	// Pass the caller's filter, never `config.jqlFilter`: callers key their
	// caches on the filter they asked for, so substituting the saved one makes
	// those keys describe data they do not hold.
	const jqlFilter = options?.jqlFilter ?? '';

	// `onProgress` and `currentUserOnly` are deliberately not forwarded:
	//   - onProgress: the Tempo fetchers report no phase-by-phase progress, so
	//     there is nothing to emit. Callers see the loading state, just not a
	//     percentage.
	//   - currentUserOnly: `scope` already selects the per-user vs team
	//     endpoint, which is the same decision expressed once. Forwarding both
	//     would let them disagree.
	// Named here because silently ignoring an option is exactly how this
	// integration lost `created`, `scope` and `jqlFilter` in the first place —
	// each looked forwarded and was not.

	return options?.scope === 'team'
		? fetchTeamMonthWorklogsTempo(config, year, month, signal, jqlFilter)
		: fetchMonthWorklogsTempo(config, year, month, signal, jqlFilter);
}
