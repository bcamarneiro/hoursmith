import {
	fetchMonthWorklogs,
	type FetchMonthOptions,
} from '../../services/monthWorklogService';
import {
	fetchMonthWorklogsTempo,
	fetchWeekWorklogsTempo,
} from '../../services/tempoWorklogService';
import { fetchWeekWorklogs } from '../../services/worklogService';
import type { Config } from '../../stores/useConfigStore';

export function readMonth(
	source: 'jira' | 'tempo',
	config: Config,
	year: number,
	month: number,
	options?: FetchMonthOptions,
	signal?: AbortSignal,
) {
	return source === 'tempo'
		? fetchMonthWorklogsTempo(config, year, month, {
				currentUserOnly: options?.currentUserOnly,
		  }, signal)
		: fetchMonthWorklogs(config, year, month, options, signal);
}

export function readWeek(
	source: 'jira' | 'tempo',
	config: Config,
	weekStart: string,
	weekEnd: string,
	options?: { currentUserOnly?: boolean },
	signal?: AbortSignal,
) {
	return source === 'tempo'
		? fetchWeekWorklogsTempo(config, weekStart, weekEnd, {
				currentUserOnly: options?.currentUserOnly,
		  }, signal)
		: fetchWeekWorklogs(config, weekStart, weekEnd, signal);
}
