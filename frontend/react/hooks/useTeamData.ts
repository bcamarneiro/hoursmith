import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorklogFetchProgress } from '../../../types/worklogLoading';
import type { TeamMemberSummary } from '../../services/teamService';
import { useConfigStore } from '../../stores/useConfigStore';
import { buildTeamSummaries } from '../utils/teamReports';
import { useAbsenceDaysByUser } from './useAbsenceDays';
import { useMonthWorklogs } from './useMonthWorklogs';
import {
	isProcessingWorkerSupported,
	postToWorker,
} from '../../workers/processingWorkerClient';
import {
	serializeUserAbsenceDays,
	deserializeTeamSummaries,
	type SerializableTeamMemberSummary,
} from '../../workers/processingWorker.types';

export function useTeamData(
	weekStart: string,
	weekEnd: string,
	options?: { enabled?: boolean },
) {
	const enabled = options?.enabled ?? true;
	const config = useConfigStore((s) => s.config);
	const [month1Progress, setMonth1Progress] =
		useState<WorklogFetchProgress | null>(null);
	const [month2Progress, setMonth2Progress] =
		useState<WorklogFetchProgress | null>(null);

	// Determine which month(s) the week spans
	const [startYear, startMonthStr] = weekStart.split('-').map(Number);
	const [endYear, endMonthStr] = weekEnd.split('-').map(Number);
	const startMonth = startMonthStr - 1;
	const endMonth = endMonthStr - 1;
	const spansMonths = startYear !== endYear || startMonth !== endMonth;

	// Primary month query (no prefetch — team page navigates by week, not month)
	const month1 = useMonthWorklogs(startYear, startMonth, {
		enabled,
		onProgress: setMonth1Progress,
	});

	// Second month query (only when week spans two months)
	const month2 = useMonthWorklogs(endYear, endMonth, {
		enabled: enabled && spansMonths,
		onProgress: setMonth2Progress,
	});
	const {
		data: absenceDaysByUser,
		isLoading: absencesLoading,
		isFetching: absencesFetching,
	} = useAbsenceDaysByUser(weekStart, weekEnd, { enabled });

	const isLoading =
		month1.isLoading || (spansMonths && month2.isLoading) || absencesLoading;
	const isFetching =
		month1.isFetching || (spansMonths && month2.isFetching) || absencesFetching;
	const error = month1.error || month2.error;
	const lastUpdatedAt = Math.max(
		month1.dataUpdatedAt ?? 0,
		spansMonths ? (month2.dataUpdatedAt ?? 0) : 0,
	);
	const loadingProgress = useMemo(() => {
		if (!spansMonths) return month1Progress;
		if (month1Progress && month2Progress) {
			return {
				phase: 'fetching-truncated' as const,
				percent: Math.round(
					(month1Progress.percent + month2Progress.percent) / 2,
				),
				message: 'Loading cross-month worklogs',
				detail: `${month1Progress.message} · ${month2Progress.message}`,
			};
		}
		return month1Progress ?? month2Progress;
	}, [spansMonths, month1Progress, month2Progress]);

	// Merge worklogs from both months
	const allWorklogs = useMemo(() => {
		const merged = [
			...(month1.data ?? []),
			...(spansMonths ? (month2.data ?? []) : []),
		];
		return merged;
	}, [month1.data, month2.data, spansMonths]);

	// Worker-based async team summary computation with sync fallback
	const [teamMembers, setTeamMembers] = useState<TeamMemberSummary[]>([]);
	const [summariesLoading, setSummariesLoading] = useState(false);
	const requestId = useRef(0);

	useEffect(() => {
		if (allWorklogs.length === 0 && !isLoading) {
			setTeamMembers([]);
			return;
		}
		if (allWorklogs.length === 0) {
			setTeamMembers([]);
			return;
		}

		const thisRequest = ++requestId.current;

		// If worker is not available, compute synchronously
		if (!isProcessingWorkerSupported()) {
			setTeamMembers(
				buildTeamSummaries(
					allWorklogs,
					weekStart,
					weekEnd,
					config.allowedUsers,
					absenceDaysByUser,
				),
			);
			return;
		}

		setSummariesLoading(true);

		postToWorker({
			type: 'buildTeamSummaries',
			payload: {
				worklogs: allWorklogs,
				weekStart,
				weekEnd,
				allowedUsers: config.allowedUsers,
				absenceDaysByUser: serializeUserAbsenceDays(absenceDaysByUser),
			},
		})
			.then((response) => {
				if (thisRequest !== requestId.current) return;
				if (response.type === 'buildTeamSummaries') {
					const items = response.result as SerializableTeamMemberSummary[];
					setTeamMembers(deserializeTeamSummaries(items));
				} else {
					// Error — fall back to sync
					setTeamMembers(
						buildTeamSummaries(
							allWorklogs,
							weekStart,
							weekEnd,
							config.allowedUsers,
							absenceDaysByUser,
						),
					);
				}
			})
			.catch(() => {
				if (thisRequest !== requestId.current) return;
				setTeamMembers(
					buildTeamSummaries(
						allWorklogs,
						weekStart,
						weekEnd,
						config.allowedUsers,
						absenceDaysByUser,
					),
				);
			})
			.finally(() => {
				if (thisRequest !== requestId.current) return;
				setSummariesLoading(false);
			});
	}, [allWorklogs, weekStart, weekEnd, config.allowedUsers, absenceDaysByUser, isLoading]);

	return {
		data: teamMembers,
		isLoading: isLoading || summariesLoading,
		isFetching,
		error,
		lastUpdatedAt: lastUpdatedAt > 0 ? lastUpdatedAt : null,
		loadingProgress,
	};
}
