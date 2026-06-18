import type React from 'react';
import type { WorklogFetchProgress } from '../../../../types/worklogLoading';
import * as styles from './WorklogLoadingStatus.module.css';

/**
 * The progress payload the loader emits. It is a superset of
 * {@link WorklogFetchProgress}: on Jira Cloud the v3 search uses cursor
 * pagination and returns no `total`, so progress is a running *count* of
 * items fetched rather than a true percentage. When no genuine total/
 * denominator is known we must NOT render a fixed percentage (it looks stuck
 * and users reload) — we render the running count plus an indeterminate bar.
 */
type LoadingProgress = WorklogFetchProgress & {
	/** Running number of items fetched so far (Cloud has no total). */
	count?: number;
	/** Genuine denominator, when the API reports one (Server/DC). */
	total?: number;
};

type Props = {
	title: string;
	progress: LoadingProgress | null;
	compact?: boolean;
};

/**
 * Jira Cloud's v3 search uses cursor pagination and reports no total, so the
 * loader can only emit a running *count* — surfaced today in `detail` as
 * "Loaded N issue(s)" (with a fixed placeholder percent). Recover that count
 * so we can show it explicitly and switch to an indeterminate bar.
 */
function runningCount(progress: LoadingProgress | null): number | null {
	if (!progress) return null;
	if (typeof progress.count === 'number' && Number.isFinite(progress.count)) {
		return progress.count;
	}
	const match = progress.detail?.match(/Loaded\s+([\d,]+)\b/i);
	if (match) {
		const n = Number(match[1].replace(/,/g, ''));
		if (Number.isFinite(n)) return n;
	}
	return null;
}

/**
 * A real percentage is only meaningful when a genuine denominator exists.
 * Treat the progress as determinate when:
 *   - a `total` is reported (Server/DC page X of Y), or
 *   - the fetch has completed (percent === 100), or
 *   - a finite `percent` was supplied AND there is no running count driving
 *     the display (i.e. the producer computed it from a real total).
 * Everything else — Cloud cursor pagination (placeholder percent + running
 * count), or a missing/invalid percent — is indeterminate.
 */
function isDeterminate(
	progress: LoadingProgress | null,
	count: number | null,
): boolean {
	if (!progress) return false;
	if (progress.phase === 'complete') return true;
	if (typeof progress.total === 'number' && progress.total > 0) return true;
	if (count !== null) return false;
	return (
		typeof progress.percent === 'number' && Number.isFinite(progress.percent)
	);
}

export const WorklogLoadingStatus: React.FC<Props> = ({
	title,
	progress,
	compact = false,
}) => {
	const count = runningCount(progress);
	const determinate = isDeterminate(progress, count);
	const percent = progress?.percent ?? 0;
	const message = progress?.message ?? 'Preparing worklog fetch…';

	// When indeterminate, prefer a running count so the user sees the fetch
	// advancing instead of a frozen percentage.
	const showCount = !determinate && count !== null;
	const detail = progress?.detail;

	return (
		<div className={compact ? styles.compact : styles.card} aria-live="polite">
			<div className={styles.header}>
				<strong>{title}</strong>
				{determinate ? (
					<span className={styles.figure}>
						{Math.round(Math.min(100, Math.max(0, percent)))}%
					</span>
				) : showCount ? (
					<span className={styles.figure}>
						<span className={styles.count}>{count}</span> fetched
					</span>
				) : null}
			</div>
			<p className={styles.message}>{message}</p>
			{detail ? <p className={styles.detail}>{detail}</p> : null}
			<div
				className={`${styles.track}${determinate ? '' : ` ${styles.indeterminate}`}`}
				style={{ height: compact ? 6 : 8 }}
				role="progressbar"
				aria-label={title}
				aria-valuemin={determinate ? 0 : undefined}
				aria-valuemax={determinate ? 100 : undefined}
				aria-valuenow={
					determinate
						? Math.round(Math.min(100, Math.max(0, percent)))
						: undefined
				}
			>
				<div
					className={styles.fill}
					style={
						determinate
							? { width: `${Math.min(100, Math.max(0, percent))}%` }
							: undefined
					}
				/>
			</div>
		</div>
	);
};
