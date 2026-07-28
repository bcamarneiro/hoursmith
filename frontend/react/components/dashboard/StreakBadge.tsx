import { useStreaks } from '../../hooks/useStreaks';
import type { DaySummary } from '../../../types/Suggestion';
import * as styles from './StreakBadge.module.css';

interface StreakBadgeProps {
	daySummaries: DaySummary[];
}

/**
 * Compact positive UI element showing on-time logging streaks.
 *
 * Displays:
 * - 🔥 Current day streak (consecutive weekdays meeting target)
 * - Best day streak (all-time record)
 * - Week streak badge when >= 1 full week
 *
 * Only renders when there's an active streak (dayStreak > 0).
 * No shaming language — silence when streak is 0.
 */
export function StreakBadge({ daySummaries }: StreakBadgeProps) {
	const { dayStreak, bestDayStreak, weekStreak, bestWeekStreak } =
		useStreaks(daySummaries);

	// Don't render if no active streak
	if (dayStreak === 0) return null;

	const isNewBest = dayStreak >= bestDayStreak && bestDayStreak > 1;

	return (
		<div className={styles.container} role="status" aria-live="polite">
			<div className={styles.primary}>
				<span className={styles.flame} aria-hidden="true">
					🔥
				</span>
				<span className={styles.count}>{dayStreak}</span>
			<span className={styles.label}>
				{dayStreak === 1 ? 'day streak' : 'day streaks'}
			</span>
				{isNewBest && <span className={styles.bestBadge}>new best!</span>}
			</div>

			<div className={styles.secondary}>
				{bestDayStreak > 0 && (
					<span className={styles.stat}>
						best: <span className={styles.statValue}>{bestDayStreak}d</span>
					</span>
				)}
				{weekStreak > 0 && (
					<span className={styles.stat}>
						weeks: <span className={styles.statValue}>{weekStreak}w</span>
						{bestWeekStreak > weekStreak && (
							<span className={styles.statDim}> / {bestWeekStreak}w best</span>
						)}
					</span>
				)}
			</div>
		</div>
	);
}
