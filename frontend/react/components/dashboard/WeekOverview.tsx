import { memo, useMemo } from 'react';
import type { DaySummary } from '../../../../types/Suggestion';
import {
	useDashboardStore,
	type WeekGhostEntry,
} from '../../../stores/useDashboardStore';
import {
	getAbsenceKindLabel,
	getAbsenceKindShortLabel,
} from '../../utils/absence';
import { parseIsoDateLocal, toLocalDateString } from '../../utils/date';
import { formatHours } from '../../utils/format';
import * as styles from './WeekOverview.module.css';

type Props = {
	days: DaySummary[];
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getDayStatus(day: DaySummary, todayStr: string): string {
	if (day.isWeekend) return styles.weekend;
	if (day.targetSeconds === 0) return styles.timeOff;
	if (day.loggedSeconds >= day.targetSeconds) return styles.complete;
	if (day.loggedSeconds > 0) return styles.partial;
	// Empty weekday: only "overdue" (red) once the day is in the past. Today and
	// future days render neutral — logging isn't owed until the day is over, so
	// painting them red is manufactured urgency (ADA-477).
	return day.date < todayStr ? styles.empty : styles.upcoming;
}

export const WeekOverview = memo<Props>(function WeekOverview({ days }) {
	const totalLogged = days.reduce((sum, d) => sum + d.loggedSeconds, 0);
	const totalTarget = days.reduce((sum, d) => sum + d.targetSeconds, 0);
	const todayStr = toLocalDateString(new Date());
	const totalPct =
		totalTarget > 0 ? Math.round((totalLogged / totalTarget) * 100) : 0;
	const weekGhosts = useDashboardStore((s) => s.weekGhosts);
	const ghostsByDay = useMemo(() => {
		const map = new Map<string, WeekGhostEntry[]>();
		for (const g of weekGhosts) {
			const list = map.get(g.date);
			if (list) list.push(g);
			else map.set(g.date, [g]);
		}
		return map;
	}, [weekGhosts]);

	return (
		<div className={styles.container}>
			<div className={styles.summary}>
				<strong>Week progress</strong>
				<span>
					{formatHours(totalLogged)} logged against {formatHours(totalTarget)}{' '}
					target
				</span>
			</div>
			<ul className={styles.grid} aria-label="Weekly worklog overview">
				{days.map((day) => {
					const pct =
						day.targetSeconds > 0
							? Math.min(100, (day.loggedSeconds / day.targetSeconds) * 100)
							: 0;
					const isToday = day.date === todayStr;
					const status = day.isWeekend
						? 'weekend'
						: day.targetSeconds === 0
							? getAbsenceKindLabel(day.absenceKind).toLowerCase()
							: day.loggedSeconds >= day.targetSeconds
								? 'complete'
								: day.loggedSeconds > 0
									? 'partially logged'
									: 'empty';
					const ghosts = ghostsByDay.get(day.date) ?? [];
					const ghostCount = ghosts.length;
					const baseTitle = `${DAY_NAMES[day.dayOfWeek]} ${day.date}: ${day.loggedSeconds > 0 ? formatHours(day.loggedSeconds) : day.targetSeconds === 0 && !day.isWeekend ? getAbsenceKindLabel(day.absenceKind) : day.isWeekend ? 'weekend' : '0h logged'}`;
					const ghostTitle =
						ghostCount > 0
							? `\n${ghosts.map((g) => `→ logged ${g.loggedOn}`).join('\n')}`
							: '';
					const baseAria = `${DAY_NAMES[day.dayOfWeek]} ${day.date}, ${status}, ${day.loggedSeconds > 0 ? formatHours(day.loggedSeconds) : day.targetSeconds === 0 && !day.isWeekend ? getAbsenceKindLabel(day.absenceKind).toLowerCase() : day.isWeekend ? 'weekend' : '0 hours logged'}`;
					const ariaLabel =
						ghostCount > 0
							? `${baseAria}, ${ghostCount} reconciled later`
							: baseAria;
					return (
						<li
							key={day.date}
							className={`${styles.day} ${getDayStatus(day, todayStr)} ${isToday ? styles.today : ''}`}
							title={`${baseTitle}${ghostTitle}`}
							aria-label={ariaLabel}
						>
							<div className={styles.dayName}>{DAY_NAMES[day.dayOfWeek]}</div>
							<div className={styles.dayDate}>
								{parseIsoDateLocal(day.date).getDate()}
							</div>
							<div className={styles.barTrack}>
								<div className={styles.barFill} style={{ height: `${pct}%` }} />
							</div>
							<div className={styles.dayHours}>
								{day.loggedSeconds > 0
									? formatHours(day.loggedSeconds)
									: day.targetSeconds === 0 && !day.isWeekend
										? getAbsenceKindShortLabel(day.absenceKind)
										: day.isWeekend
											? ''
											: '0h'}
								{ghostCount > 0 && (
									<span
										className={styles.ghostDot}
										aria-hidden="true"
										data-testid="week-overview-ghost-dot"
									/>
								)}
							</div>
						</li>
					);
				})}
			</ul>
			<div className={styles.totals}>
				<span>
					{formatHours(totalLogged)} / {formatHours(totalTarget)}
				</span>
				{totalTarget > 0 && <span className={styles.pct}>{totalPct}%</span>}
			</div>
		</div>
	);
});
