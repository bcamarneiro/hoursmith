import {
	type FetchMonthOptions,
	fetchMonthWorklogs,
} from '../../services/monthWorklogService';
import {
	fetchMonthWorklogsTempo,
	fetchTeamMonthWorklogsTempo,
	fetchWeekWorklogsTempo,
} from '../../services/tempoWorklogService';
import { fetchWeekWorklogs } from '../../services/worklogService';
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
	return options?.scope === 'team'
		? fetchTeamMonthWorklogsTempo(config, year, month, signal)
		: fetchMonthWorklogsTempo(config, year, month, signal);
}

export function readWeek(
	source: 'jira' | 'tempo',
	config: Config,
	weekStart: string,
	weekEnd: string,
	signal?: AbortSignal,
) {
	return source === 'tempo'
		? fetchWeekWorklogsTempo(config, weekStart, weekEnd, signal)
		: fetchWeekWorklogs(config, weekStart, weekEnd, signal);
}
