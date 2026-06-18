import type React from 'react';
import { useMemo, useState } from 'react';
import type { EnrichedJiraWorklog } from '../../../types/jira';
import type { AbsenceDay } from '../../services/absenceService';
import { useTimesheetStore } from '../../stores/useTimesheetStore';
import { useCalendar } from '../hooks/useCalendar';
import { useMonthTotalCalculation } from '../hooks/useMonthTotalCalculation';
import {
	getWorkdayDatesInMonth,
	isoDateFromYMD,
	isWeekendDay,
} from '../utils/date';
import { sumWeekdayTargetSeconds } from '../utils/dayTarget';
import { computeCompliancePct } from '../utils/format';
import { projectDays } from '../utils/projectDays';
import { classifyWorklog } from '../utils/worklogClassifier';
import { CalendarGrid } from './calendar/CalendarGrid';
import { DayCell } from './DayCell';
import * as styles from './TimesheetGrid.module.css';
import { HoursProgressLine } from './ui/HoursProgressLine';
import { ProgressBar } from './ui/ProgressBar';
import { UserHeader } from './user/UserHeader';

type Props = {
	user: string;
	days: Record<string, EnrichedJiraWorklog[]>;
	issueSummaries: Record<string, string>;
	onDownloadUser: (user: string) => void;
	absenceDays?: Map<string, AbsenceDay>;
	defaultCollapsed?: boolean;
};

export const TimesheetGrid: React.FC<Props> = ({
	user,
	days,
	issueSummaries,
	onDownloadUser,
	absenceDays,
	defaultCollapsed = false,
}) => {
	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	const year = useTimesheetStore((state) => state.currentYear);
	const monthZeroIndexed = useTimesheetStore((state) => state.currentMonth);

	const { firstWeekday, numDays, weekdayLabels } = useCalendar(
		year,
		monthZeroIndexed,
	);

	const projected = useMemo(() => projectDays(days), [days]);

	const { totalSeconds } = useMonthTotalCalculation(
		projected.loggedDays,
		year,
		monthZeroIndexed,
	);

	const targetSeconds = useMemo(() => {
		const workdays = getWorkdayDatesInMonth(year, monthZeroIndexed);
		// Per-day logged seconds (non-backdated only) so partial-PTO days
		// reduce the target by exactly the unworked portion.
		const loggedByDay = new Map<string, number>();
		for (const [day, list] of Object.entries(projected.loggedDays)) {
			let counted = 0;
			for (const wl of list) {
				if (classifyWorklog(wl).isBackdated) continue;
				counted += wl.timeSpentSeconds ?? 0;
			}
			if (counted > 0) loggedByDay.set(day, counted);
		}
		return sumWeekdayTargetSeconds(
			workdays,
			(d) => absenceDays?.has(d) ?? false,
			(d) => loggedByDay.get(d) ?? 0,
		);
	}, [projected.loggedDays, absenceDays, year, monthZeroIndexed]);
	const pct = computeCompliancePct(totalSeconds, targetSeconds);

	const now = new Date();
	const todayIso =
		now.getFullYear() === year && now.getMonth() === monthZeroIndexed
			? isoDateFromYMD(year, monthZeroIndexed, now.getDate())
			: null;

	const cells: React.ReactNode[] = [];

	for (let d = 1; d <= numDays; d++) {
		const iso = isoDateFromYMD(year, monthZeroIndexed, d);
		const worklogs = projected.loggedDays[iso] || [];
		const ghosts = projected.ghostsByDay[iso];
		const jsDate = new Date(Date.UTC(year, monthZeroIndexed, d));
		const weekday = jsDate.getUTCDay();
		const isWeekend = isWeekendDay(weekday);
		const absenceDay = absenceDays?.get(iso);
		const isAbsent = !!absenceDay;

		cells.push(
			<DayCell
				key={iso}
				iso={iso}
				dayNumber={d}
				worklogs={worklogs}
				ghosts={ghosts}
				issueSummaries={issueSummaries}
				isWeekend={isWeekend}
				isAbsent={isAbsent}
				absenceDay={absenceDay}
				isToday={iso === todayIso}
			/>,
		);
	}

	return (
		<div key={user} className={styles.card}>
			<UserHeader
				user={user}
				totalSeconds={totalSeconds}
				targetSeconds={targetSeconds}
				onDownloadUser={onDownloadUser}
				collapsed={collapsed}
				onToggleCollapse={() => setCollapsed((c) => !c)}
			/>

			{!collapsed && (
				<>
					<CalendarGrid
						firstWeekday={firstWeekday}
						weekdayLabels={weekdayLabels}
					>
						{cells}
					</CalendarGrid>

					<div className={styles.monthTotal}>
						<div className={styles.monthTotalTop}>
							<span className={styles.monthTotalLabel}>Month Total</span>
							<HoursProgressLine
								className={styles.monthTotalValue}
								totalSeconds={totalSeconds}
								targetSeconds={targetSeconds}
							/>
						</div>
						<ProgressBar value={pct} height={6} />
					</div>
				</>
			)}
		</div>
	);
};
