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
 * with an on-time score and drill-through to that person's worklogs. Worst
 * record first (the model pre-sorts) so a lead spots chronic laggards.
 */
export function TeamRagGrid({ members }: { members: OnTimeHistoryMember[] }) {
	if (members.length === 0) return null;
	const weeks = members[0].weeks;

	return (
		<section className={styles.panel} aria-labelledby="rag-grid-title">
			<div className={styles.header}>
				<strong id="rag-grid-title">Completeness by week</strong>
				<span>
					On-time status per person across the trend window. Click a name to
					drill into their worklogs.
				</span>
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
						{members.map((member) => (
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
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
