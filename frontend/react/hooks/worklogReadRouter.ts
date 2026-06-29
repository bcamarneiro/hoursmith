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
		? fetchMonthWorklogsTempo(config, year, month, signal)
		: fetchMonthWorklogs(config, year, month, options, signal);
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
