import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getWorklogSource } from '../../services/worklogSource';
import { useConfigStore } from '../../stores/useConfigStore';
import { useUIStore } from '../../stores/useUIStore';
import { addDaysToIsoDate, parseIsoDateLocal } from '../utils/date';
import { buildManagerTrendModel } from '../utils/teamReports';
import { useAbsenceDaysByUser } from './useAbsenceDays';
import { useEffectiveProxyUrl } from './useEffectiveProxyUrl';
import { monthWorklogsQueryKey } from './useMonthWorklogs';
import { readMonth } from './worklogReadRouter';

function getMonthsInRange(startDate: string, endDate: string) {
	const cursor = parseIsoDateLocal(startDate);
	cursor.setDate(1);
	const last = parseIsoDateLocal(endDate);
	last.setDate(1);

	const pairs: Array<{ year: number; month: number }> = [];
	while (cursor <= last) {
		pairs.push({
			year: cursor.getFullYear(),
			month: cursor.getMonth(),
		});
		cursor.setMonth(cursor.getMonth() + 1);
	}

	return pairs;
}

export function useReportsTrendData(
	weekStart: string,
	trendWeeks: number,
	options?: { enabled?: boolean },
) {
	const queryClient = useQueryClient();
	const rawConfig = useConfigStore((state) => state.config);
	const tempoSuspected = useUIStore((s) => s.tempoSuspected);
	const source = getWorklogSource({
		tempoMode: rawConfig.tempoMode,
		tempoApiToken: rawConfig.tempoApiToken,
		tempoSuspected,
	});
	// Auto-resolve to the hosted Premium proxy when entitled (ADA-273).
	const effectiveProxy = useEffectiveProxyUrl();
	const config = useMemo(
		() => ({ ...rawConfig, corsProxy: effectiveProxy }),
		[rawConfig, effectiveProxy],
	);
	const enabled =
		(options?.enabled ?? true) && !!config.jiraHost && !!config.apiToken;
	const firstWeekStart = addDaysToIsoDate(weekStart, -7 * (trendWeeks - 1));
	const lastWeekEnd = addDaysToIsoDate(weekStart, 6);
	const absenceQuery = useAbsenceDaysByUser(firstWeekStart, lastWeekEnd, {
		enabled,
	});

	const worklogsQuery = useQuery({
		queryKey: [
			'reportsTrends',
			weekStart,
			trendWeeks,
			config.jiraHost,
			config.corsProxy,
			config.allowedUsers,
			source,
		],
		enabled,
		staleTime: 15 * 60 * 1000,
		queryFn: async () => {
			const monthPairs = getMonthsInRange(firstWeekStart, lastWeekEnd);
			const results = await Promise.all(
				monthPairs.map(({ year, month }) =>
					queryClient.fetchQuery({
						queryKey: monthWorklogsQueryKey(
							year,
							month,
							config.jiraHost,
							config.corsProxy,
							false,
							'',
							source,
						),
						queryFn: ({ signal }) =>
							readMonth(source, config, year, month, {}, signal),
						staleTime: 15 * 60 * 1000,
					}),
				),
			);

			return results.flat();
		},
	});

	const model = useMemo(() => {
		if (!worklogsQuery.data) return undefined;

		return buildManagerTrendModel(
			worklogsQuery.data,
			weekStart,
			trendWeeks,
			config.allowedUsers,
			absenceQuery.data,
		);
	}, [
		worklogsQuery.data,
		weekStart,
		trendWeeks,
		config.allowedUsers,
		absenceQuery.data,
	]);

	return {
		...worklogsQuery,
		data: model,
		isLoading: worklogsQuery.isLoading || absenceQuery.isLoading,
		isFetching: worklogsQuery.isFetching || absenceQuery.isFetching,
		error: worklogsQuery.error ?? absenceQuery.error,
	};
}
