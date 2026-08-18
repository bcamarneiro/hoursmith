import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { parseIsoDateLocal } from '../../utils/date';
import {
	describeOnTimeStatus,
	type OnTimeStatus,
} from '../../utils/onTimeStatus';
import type { OnTimeHistoryMember } from '../../utils/teamReports';
import * as styles from './TeamRagGrid.module.css';

// Status tone → cell class. Rides the green/amber/red worklog ramp + a neutral
// "in progress" — never the ember brand accent (brand rule).
const TONE_CLASS: Record<string, string> = {
	success: styles.cellSuccess,
	warning: styles.cellWarning,
	error: styles.cellError,
	neutral: styles.cellNeutral,
};

type SortKey = 'worst' | 'status' | 'name';

// Lower = more urgent, so an ascending sort surfaces the worst first. `null`
// (never rated) sorts last.
const STATUS_SEVERITY: Record<OnTimeStatus, number> = {
	incomplete: 0,
	late: 1,
	pending: 2,
	'on-time': 3,
};

function severity(status: OnTimeStatus | null): number {
	return status ? STATUS_SEVERITY[status] : 4;
}

// "Needs attention" = anything that isn't on-time and has been rated. A member
// with no rated week (null) isn't flagged.
function needsAttention(status: OnTimeStatus | null): boolean {
	return status !== null && status !== 'on-time';
}

function weekLabel(weekStart: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
	}).format(parseIsoDateLocal(weekStart));
}

function statusLabel(status: OnTimeStatus | null): string {
	return status ? describeOnTimeStatus(status).label : 'No data';
}

/**
 * Team completeness RAG grid (ADA-388): per-person × per-week on-time status,
 * with an on-time score and drill-through to that person's worklogs. Sortable
 * and filterable (ADA-548) so a lead can jump straight to who's behind.
 */
export function TeamRagGrid({ members }: { members: OnTimeHistoryMember[] }) {
	const [onlyAttention, setOnlyAttention] = useState(false);
	const [sortBy, setSortBy] = useState<SortKey>('worst');
	const attentionId = useId();
	const sortId = useId();

	const visible = useMemo(() => {
		const filtered = onlyAttention
			? members.filter((member) => needsAttention(member.currentStatus))
			: members;
		const sorted = [...filtered];
		if (sortBy === 'name') {
			sorted.sort((a, b) => a.displayName.localeCompare(b.displayName));
		} else if (sortBy === 'status') {
			sorted.sort(
				(a, b) =>
					severity(a.currentStatus) - severity(b.currentStatus) ||
					a.displayName.localeCompare(b.displayName),
			);
		} else {
			// 'worst': fewest on-time weeks first (the model's default order),
			// tie-broken by name.
			sorted.sort(
				(a, b) =>
					a.onTimeWeeks - b.onTimeWeeks ||
					a.displayName.localeCompare(b.displayName),
			);
		}
		return sorted;
	}, [members, onlyAttention, sortBy]);

	if (members.length === 0) return null;
	const weeks = members[0].weeks;
	const colSpan = weeks.length + 2;

	return (
		<section className={styles.panel} aria-labelledby="rag-grid-title">
			<div className={styles.header}>
				<div className={styles.headerText}>
					<strong id="rag-grid-title">Completeness by week</strong>
					<span>
						On-time status per person across the trend window. Click a name to
						drill into their worklogs.
					</span>
				</div>
				<div className={styles.controls}>
					<label className={styles.control} htmlFor={attentionId}>
						<input
							id={attentionId}
							type="checkbox"
							checked={onlyAttention}
							onChange={(event) => setOnlyAttention(event.target.checked)}
						/>
						Only needs attention
					</label>
					<label className={styles.control} htmlFor={sortId}>
						Sort
						<select
							id={sortId}
							value={sortBy}
							onChange={(event) => setSortBy(event.target.value as SortKey)}
						>
							<option value="worst">Worst record</option>
							<option value="status">Current status</option>
							<option value="name">Name</option>
						</select>
					</label>
				</div>
			</div>
			<div className={styles.tableWrap}>
				<table className={styles.table}>
					<thead>
						<tr>
							<th scope="col">Team member</th>
							{weeks.map((week) => (
								<th
									key={week.weekStart}
									scope="col"
									className={styles.weekHead}
								>
									{weekLabel(week.weekStart)}
								</th>
							))}
							<th scope="col" className={styles.scoreHead}>
								On time
							</th>
						</tr>
					</thead>
					<tbody>
						{visible.length === 0 ? (
							<tr>
								<td colSpan={colSpan} className={styles.emptyRow}>
									Everyone on the roster is on time. 🎉
								</td>
							</tr>
						) : (
							visible.map((member) => (
								<tr key={member.email || member.displayName}>
									<td className={styles.nameCell}>
										<Link
											to={`/reports?user=${encodeURIComponent(member.displayName)}`}
											className={styles.nameLink}
										>
											{member.displayName}
										</Link>
									</td>
									{member.weeks.map((week) => {
										const tone = week.status
											? describeOnTimeStatus(week.status).tone
											: 'neutral';
										return (
											<td
												key={week.weekStart}
												className={`${styles.cell} ${
													week.status ? TONE_CLASS[tone] : styles.cellEmpty
												}`}
												title={`Week of ${week.weekStart}: ${statusLabel(week.status)}`}
											>
												<span className={styles.srOnly}>
													{statusLabel(week.status)}
												</span>
											</td>
										);
									})}
									<td className={styles.scoreCell}>
										{member.onTimeWeeks}/{member.ratedWeeks}
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>
		</section>
	);
}
