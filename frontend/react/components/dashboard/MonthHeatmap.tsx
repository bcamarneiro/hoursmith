import { useState, useCallback, useEffect, useRef } from 'react';
import type React from 'react';
import type { AbsenceDay } from '../../../services/absenceService';
import { getAbsenceKindLabel } from '../../utils/absence';
import { isWeekendDay, monthLabel } from '../../utils/date';
import { formatHours } from '../../utils/format';
import * as styles from './MonthHeatmap.module.css';

type Props = {
	monthData: Map<string, number>;
	/**
	 * Optional per-day backdated seconds. When > 0 for a day, an overlay
	 * stripe is drawn on the cell to indicate the day's totals include
	 * backdated worklogs. The total hours shown stay unchanged.
	 */
	backdatedSeconds?: Map<string, number>;
	month: number;
	year: number;
	absenceDays?: Map<string, AbsenceDay>;
};

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const cellLevelMap: Record<string, string> = {
	placeholder: styles.cellPlaceholder,
	empty: styles.cellEmpty,
	level1: styles.cellLevel1,
	level2: styles.cellLevel2,
	level3: styles.cellLevel3,
	level4: styles.cellLevel4,
	vacation: styles.cellVacation,
};

const legendLevelMap: Record<string, string> = {
	empty: styles.legendCellEmpty,
	level1: styles.legendCellLevel1,
	level2: styles.legendCellLevel2,
	level3: styles.legendCellLevel3,
	level4: styles.legendCellLevel4,
};

function getLevel(seconds: number): string {
	const hours = seconds / 3600;
	if (hours <= 0) return 'empty';
	if (hours < 4) return 'level1';
	if (hours < 7) return 'level2';
	if (hours <= 8) return 'level3';
	return 'level4';
}

export const MonthHeatmap: React.FC<Props> = ({
	monthData,
	backdatedSeconds,
	month,
	year,
	absenceDays,
}) => {
	const daysInMonth = new Date(year, month + 1, 0).getDate();

	// Build cells with leading placeholders for alignment
	// We want Monday-first grid, so compute offset
	const firstDay = new Date(year, month, 1).getDay();
	// Convert Sunday=0 to Monday-first: Mon=0, Tue=1, ..., Sun=6
	const offset = firstDay === 0 ? 6 : firstDay - 1;

	const cells: Array<{
		day: number;
		dateStr: string;
		seconds: number;
		isPlaceholder: boolean;
		isWeekend: boolean;
	}> = [];

	// Add placeholder cells for days before the 1st
	// Use negative day numbers to ensure unique keys
	for (let i = 0; i < offset; i++) {
		cells.push({
			day: -(i + 1),
			dateStr: `placeholder-${i}`,
			seconds: 0,
			isPlaceholder: true,
			isWeekend: false,
		});
	}

	// Add actual day cells
	for (let d = 1; d <= daysInMonth; d++) {
		const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
		const dateObj = new Date(year, month, d);
		const dayOfWeek = dateObj.getDay();
		const seconds = monthData.get(dateStr) ?? 0;

		cells.push({
			day: d,
			dateStr,
			seconds,
			isPlaceholder: false,
			isWeekend: isWeekendDay(dayOfWeek),
		});
	}

	const legendLevels = ['empty', 'level1', 'level2', 'level3', 'level4'];
	const showAbsenceLegend = absenceDays && absenceDays.size > 0;
	const totalLoggedSeconds = [...monthData.values()].reduce(
		(sum, seconds) => sum + seconds,
		0,
	);
	const loggedDaysCount = [...monthData.values()].filter(
		(seconds) => seconds > 0,
	).length;

	// Accessibility: disclosure popover for keyboard/touch users
	const [activePopover, setActivePopover] = useState<string | null>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const cellRefs = useRef<Map<string, HTMLLIElement>>(new Map());
	const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

	const togglePopover = useCallback((key: string) => {
		setActivePopover((prev) => (prev === key ? null : key));
	}, []);

	const closePopover = useCallback(() => {
		setActivePopover(null);
	}, []);

	// Position the popover relative to the active cell
	useEffect(() => {
		if (!activePopover) return;
		const cellEl = cellRefs.current.get(activePopover);
		const containerEl = containerRef.current;
		if (!cellEl || !containerEl) return;
		const cellRect = cellEl.getBoundingClientRect();
		const containerRect = containerEl.getBoundingClientRect();
		setPopoverStyle({
			position: 'absolute',
			top: cellRect.bottom - containerRect.top + 4,
			left: cellRect.left - containerRect.left,
		});
	}, [activePopover]);

	// Close popover on Escape
	useEffect(() => {
		if (!activePopover) return;
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') closePopover();
		};
		document.addEventListener('keydown', handleKey);
		return () => document.removeEventListener('keydown', handleKey);
	}, [activePopover, closePopover]);

	// Close popover on outside pointer-down (no setTimeout race)
	useEffect(() => {
		if (!activePopover) return;
		const handlePointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (popoverRef.current?.contains(target)) return;
			const cellEl = cellRefs.current.get(activePopover);
			if (cellEl?.contains(target)) return;
			closePopover();
		};
		document.addEventListener('pointerdown', handlePointerDown);
		return () => document.removeEventListener('pointerdown', handlePointerDown);
	}, [activePopover, closePopover]);

	const activeCell = activePopover
		? cells.find((c) => c.dateStr === activePopover && !c.isPlaceholder)
		: null;

	return (
		<div className={styles.container} ref={containerRef}>
			<div className={styles.header}>{monthLabel(year, month)}</div>
			<div className={styles.summary}>
				<span>{formatHours(totalLoggedSeconds)} logged</span>
				<span>{loggedDaysCount} active days</span>
			</div>

			<div className={styles.dayLabels}>
				{DAY_HEADERS.map((label) => (
					<div key={label} className={styles.dayLabel}>
						{label}
					</div>
				))}
			</div>

			<ul
				className={styles.grid}
				aria-label={`Month heatmap for ${monthLabel(year, month)}`}
			>
				{cells.map((cell) => {
					if (cell.isPlaceholder) {
						const placeholderClass = cellLevelMap.placeholder;
						return (
							<li
								key={cell.dateStr}
								className={`${styles.cell} ${placeholderClass}`}
								aria-hidden="true"
							/>
						);
					}

					const absenceDay = absenceDays?.get(cell.dateStr);
					const isTimeOff = !!absenceDay;
					const hours = cell.seconds / 3600;
					// When PTO collides with logged work, drop the vacation tint
					// and show the regular intensity level — a separate overlay
					// stripe marks the conflict. A clean PTO day still gets the
					// vacation level.
					const workedOnPto = isTimeOff && cell.seconds > 0;
					const level =
						isTimeOff && !workedOnPto ? 'vacation' : getLevel(cell.seconds);
					const levelClass = cellLevelMap[level] ?? cellLevelMap.empty;
					const weekendClass = cell.isWeekend ? styles.cellWeekend : '';
					const backdated = backdatedSeconds?.get(cell.dateStr) ?? 0;
					const hasBackdated = backdated > 0 && !isTimeOff;
					let baseTitle: string;
					if (workedOnPto) {
						baseTitle = `${cell.dateStr}: ${formatHours(cell.seconds)} logged on ${getAbsenceKindLabel(absenceDay.kind)} ⚠`;
					} else if (isTimeOff) {
						baseTitle = `${cell.dateStr}: ${getAbsenceKindLabel(absenceDay.kind)}`;
					} else if (hours > 0) {
						baseTitle = `${cell.dateStr}: ${formatHours(cell.seconds)}`;
					} else {
						baseTitle = `${cell.dateStr}: no time logged`;
					}
					const title = hasBackdated
						? `${baseTitle} (+ ${formatHours(backdated)} backdated, not counted)`
						: baseTitle;

					return (
						<li
							key={cell.dateStr}
							ref={(el) => {
								if (el) {
									cellRefs.current.set(cell.dateStr, el);
								} else {
									cellRefs.current.delete(cell.dateStr);
								}
							}}
							tabIndex={0}
							role="button"
							aria-expanded={activePopover === cell.dateStr}
							aria-describedby={
								activePopover === cell.dateStr
									? `heatmap-popover-${cell.dateStr}`
									: undefined
							}
							className={`${styles.cell} ${levelClass} ${weekendClass} ${hasBackdated ? styles.cellBackdated : ''} ${workedOnPto ? styles.cellWorkedOnPto : ''}`}
							title={title}
							aria-label={title}
							onClick={() => togglePopover(cell.dateStr)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									togglePopover(cell.dateStr);
								}
							}}
						>
							{cell.day}
						</li>
					);
				})}
			</ul>

			{activeCell && activePopover && (() => {
				const absDay = absenceDays?.get(activeCell.dateStr);
				const isTimeOff = !!absDay;
				const hours = activeCell.seconds / 3600;
				const workedOnPto = isTimeOff && activeCell.seconds > 0;
				const backdated = backdatedSeconds?.get(activeCell.dateStr) ?? 0;
				const hasBackdated = backdated > 0 && !isTimeOff;
				let popoverText: string;
				if (workedOnPto) {
					popoverText = `${activeCell.dateStr}: ${formatHours(activeCell.seconds)} logged on ${getAbsenceKindLabel(absDay!.kind)} ⚠`;
				} else if (isTimeOff) {
					popoverText = `${activeCell.dateStr}: ${getAbsenceKindLabel(absDay!.kind)}`;
				} else if (hours > 0) {
					popoverText = `${activeCell.dateStr}: ${formatHours(activeCell.seconds)}`;
				} else {
					popoverText = `${activeCell.dateStr}: no time logged`;
				}
				if (hasBackdated) {
					popoverText += ` (+ ${formatHours(backdated)} backdated, not counted)`;
				}
				return (
					<div
						id={`heatmap-popover-${activeCell.dateStr}`}
						ref={popoverRef}
						className={styles.popover}
						role="dialog"
						aria-label={`Details for ${activeCell.dateStr}`}
						style={popoverStyle}
					>
						{popoverText}
					</div>
				);
			})()}

			<div className={styles.footer}>
				{showAbsenceLegend && (
					<>
						<div
							className={`${styles.legendCell} ${styles.legendCellVacation}`}
						/>
						<span className={styles.legendLabel}>Time off</span>
					</>
				)}
				<span className={styles.legendLabel}>Less</span>
				<div className={styles.legendCells}>
					{legendLevels.map((level) => {
						const cls = legendLevelMap[level] ?? legendLevelMap.empty;
						return (
							<div key={level} className={`${styles.legendCell} ${cls}`} />
						);
					})}
				</div>
				<span className={styles.legendLabel}>More</span>
			</div>
		</div>
	);
};
