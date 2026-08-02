import { useMemo, useState } from 'react';
import {
	getDaysInMonth,
	getMonthStartWeekday,
	isoDateFromYMD,
	monthLabel,
} from '../../utils/date';
import * as styles from './CloneWorklogPopover.module.css';

type Props = {
	issueKey: string;
	timeSpent: string;
	/** ISO date (YYYY-MM-DD) the worklog being cloned lives on. */
	sourceDate: string;
	onClone: (dates: string[]) => void;
	onCancel: () => void;
	/** Disables the Clone button and shows a loading indicator during the clone operation. */
	isLoading?: boolean;
	/** An error message to display inline inside the popover (e.g. after a clone failure). */
	error?: string | null;
};

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CloneWorklogPopover({
	issueKey,
	timeSpent,
	sourceDate,
	onClone,
	onCancel,
	isLoading = false,
	error = null,
}: Props) {
	const [sourceYear, sourceMonth] = useMemo(() => {
		const [y, m] = sourceDate.split('-').map(Number);
		return [y, m - 1] as const;
	}, [sourceDate]);

	const [viewYear, setViewYear] = useState(sourceYear);
	const [viewMonth, setViewMonth] = useState(sourceMonth);
	const [selected, setSelected] = useState<Set<string>>(() => new Set());

	const goPrevMonth = () => {
		setViewMonth((m) => (m === 0 ? 11 : m - 1));
		if (viewMonth === 0) setViewYear((y) => y - 1);
	};
	const goNextMonth = () => {
		setViewMonth((m) => (m === 11 ? 0 : m + 1));
		if (viewMonth === 11) setViewYear((y) => y + 1);
	};

	const toggle = (iso: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(iso)) next.delete(iso);
			else next.add(iso);
			return next;
		});
	};

	// Monday-first leading blanks: getMonthStartWeekday is 0=Sun..6=Sat.
	const startWeekday = getMonthStartWeekday(viewYear, viewMonth);
	const leadingBlanks = (startWeekday + 6) % 7;
	const daysInMonth = getDaysInMonth(viewYear, viewMonth);
	const cells: (number | null)[] = [
		...Array<null>(leadingBlanks).fill(null),
		...Array.from({ length: daysInMonth }, (_, i) => i + 1),
	];

	const sortedSelected = [...selected].sort();

	return (
		<div className={styles.popover}>
			<p className={styles.context}>
				Clone <strong>{issueKey}</strong> · {timeSpent} to…
			</p>

			<div className={styles.monthNav}>
				<button
					type="button"
					className={styles.navButton}
					onClick={goPrevMonth}
					aria-label="Previous month"
				>
					‹
				</button>
				<span className={styles.monthLabel}>
					{monthLabel(viewYear, viewMonth)}
				</span>
				<button
					type="button"
					className={styles.navButton}
					onClick={goNextMonth}
					aria-label="Next month"
				>
					›
				</button>
			</div>

			<div className={styles.weekdayRow}>
				{WEEKDAY_LABELS.map((w) => (
					<span key={w} className={styles.weekdayLabel}>
						{w}
					</span>
				))}
			</div>

			<div className={styles.grid}>
				{cells.map((day, i) => {
					if (day === null) {
						// biome-ignore lint/suspicious/noArrayIndexKey: blank padding cells
						return <span key={`blank-${i}`} className={styles.blank} />;
					}
					const iso = isoDateFromYMD(viewYear, viewMonth, day);
					const isSource = iso === sourceDate;
					const isSelected = selected.has(iso);
					return (
						<button
							key={iso}
							type="button"
							className={`${styles.day} ${isSelected ? styles.selected : ''} ${isSource ? styles.source : ''}`}
							onClick={() => toggle(iso)}
							disabled={isSource}
							aria-pressed={isSource ? undefined : isSelected}
							aria-label={isSource ? `${iso} (source)` : iso}
						>
							{day}
						</button>
					);
				})}
			</div>

			{error && <p className={styles.error}>{error}</p>}

			{sortedSelected.length > 0 && (
				<div className={styles.chips}>
					{sortedSelected.map((iso) => (
						<button
							key={iso}
							type="button"
							className={styles.chip}
							onClick={() => toggle(iso)}
							aria-label={`Remove ${iso}`}
						>
							{iso.slice(5)} ✕
						</button>
					))}
				</div>
			)}

			<div className={styles.footer}>
				<span className={styles.count}>{selected.size} selected</span>
				<div className={styles.footerActions}>
					<button
						type="button"
						className={styles.cancelButton}
						onClick={onCancel}
						disabled={isLoading}
					>
						Cancel
					</button>
					<button
						type="button"
						className={styles.cloneButton}
						onClick={() => onClone(sortedSelected)}
						disabled={selected.size === 0 || isLoading}
					>
						{isLoading ? 'Cloning...' : `Clone → ${selected.size}`}
					</button>
				</div>
			</div>
		</div>
	);
}
