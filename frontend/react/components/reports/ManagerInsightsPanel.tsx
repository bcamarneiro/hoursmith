import type React from 'react';
import type { TeamMemberSummary } from '../../../services/teamService';
import { parseIsoDateLocal } from '../../utils/date';
import { formatHours } from '../../utils/format';
import type {
	ManagerTrendModel,
	TeamTrendPoint,
} from '../../utils/teamReports';
import { ProgressBar } from '../ui/ProgressBar';
import { Spinner } from '../ui/Spinner';
import { StatCard } from '../ui/StatCard';
import * as styles from './ManagerInsightsPanel.module.css';
import { TeamRagGrid } from './TeamRagGrid';

type Props = {
	trendWeeks: number;
	onTrendWeeksChange: (value: number) => void;
	currentMembers: TeamMemberSummary[];
	model?: ManagerTrendModel;
	isLoading: boolean;
	errorMessage?: string;
};

function formatWeekLabel(week: TeamTrendPoint, isCurrent: boolean): string {
	const start = parseIsoDateLocal(week.weekStart);
	const end = parseIsoDateLocal(week.weekEnd);
	const formatter = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
	});
	const range = `${formatter.format(start)} - ${formatter.format(end)}`;
	return isCurrent ? `${range} (current)` : range;
}

export const ManagerInsightsPanel: React.FC<Props> = ({
	trendWeeks,
	onTrendWeeksChange,
	currentMembers,
	model,
	isLoading,
	errorMessage,
}) => {
	// "Attention Now" counts who is behind *relative to elapsed days* (prorated),
	// not who still has any full-week gap — otherwise everyone reads red on
	// Monday morning for hours not yet owed (ADA-477). Falls back to the
	// full-week gap when a producer didn't prorate.
	const attentionNow = currentMembers.filter(
		(member) => (member.proratedGapSeconds ?? member.gapSeconds) > 0,
	).length;
	const currentGapSeconds = currentMembers.reduce(
		(sum, member) => sum + member.gapSeconds,
		0,
	);
	const recurringCount =
		model?.recurringGapMembers.filter((member) => member.gapWeeks > 1).length ??
		0;

	return (
		<section className={styles.panel} aria-labelledby="manager-insights-title">
			<div className={styles.header}>
				<div>
					<p className={styles.kicker}>Manager mode</p>
					<h2 id="manager-insights-title">Multi-week team signals</h2>
					<p className={styles.description}>
						This panel stays team-wide for the configured reporting scope so
						recurring compliance patterns stay visible even when the table below
						is filtered.
					</p>
				</div>
				<label className={styles.rangeField}>
					<span>Trend window</span>
					<select
						value={trendWeeks}
						onChange={(event) =>
							onTrendWeeksChange(Number.parseInt(event.target.value, 10))
						}
					>
						<option value={4}>4 weeks</option>
						<option value={6}>6 weeks</option>
						<option value={8}>8 weeks</option>
						<option value={12}>12 weeks</option>
					</select>
				</label>
			</div>

			<div className={styles.statsGrid}>
				<StatCard label="Attention Now" value={attentionNow} />
				<StatCard label="Open Gap" value={formatHours(currentGapSeconds)} />
				<StatCard
					label={`${trendWeeks}-Week Avg Compliance`}
					value={model ? `${model.averageComplianceRate}%` : '—'}
				/>
				<StatCard label="Recurring Gaps" value={recurringCount} />
			</div>

			{isLoading && !model ? (
				<div className={styles.loading}>
					<Spinner size="sm" />
					<span>Loading multi-week trends...</span>
				</div>
			) : null}

			{errorMessage ? (
				<div className={styles.errorBox}>
					<strong>Unable to load manager insights</strong>
					<p>{errorMessage}</p>
				</div>
			) : null}

			{model && model.onTimeHistory.length > 0 ? (
				<TeamRagGrid members={model.onTimeHistory} />
			) : null}

			{model ? (
				<div className={styles.contentGrid}>
					<section className={styles.trendSection}>
						<div className={styles.sectionHeader}>
							<strong>Weekly trend</strong>
							<span>{trendWeeks} consecutive Mondays ending this week</span>
						</div>
						<div className={styles.trendList}>
							{model.weeks.map((week, index) => {
								const isCurrent = index === model.weeks.length - 1;
								return (
									<article key={week.weekStart} className={styles.trendCard}>
										<div className={styles.trendCardHeader}>
											<strong>{formatWeekLabel(week, isCurrent)}</strong>
											{isCurrent ? (
												<span className={styles.currentBadge}>Current</span>
											) : null}
										</div>
										<div className={styles.progressRow}>
											<div className={styles.progressTrack}>
												<ProgressBar value={week.complianceRate} height={6} />
											</div>
											<span>{week.complianceRate}% compliant</span>
										</div>
										<div className={styles.trendMeta}>
											<span>{formatHours(week.totalSeconds)} logged</span>
											<span>{formatHours(week.totalGapSeconds)} gap</span>
											<span>{week.attentionCount} need attention</span>
										</div>
									</article>
								);
							})}
						</div>
					</section>

					<section className={styles.attentionSection}>
						<div className={styles.sectionHeader}>
							<strong>Recurring attention list</strong>
							<span>
								People showing gaps across this {trendWeeks}-week window
							</span>
						</div>
						{model.recurringGapMembers.length > 0 ? (
							<ul className={styles.attentionList}>
								{model.recurringGapMembers.slice(0, 5).map((member) => (
									<li key={member.email} className={styles.attentionItem}>
										<div>
											<strong>{member.displayName}</strong>
											<span>{member.gapWeeks} weeks with gap</span>
										</div>
										<div className={styles.attentionMetrics}>
											<span>
												Current: {formatHours(member.currentGapSeconds)}
											</span>
											<span>
												Avg gap: {formatHours(member.averageGapSeconds)}
											</span>
											<span>
												Logged now: {formatHours(member.currentLoggedSeconds)}
											</span>
										</div>
									</li>
								))}
							</ul>
						) : (
							<p className={styles.emptyState}>
								No recurring gap pattern detected across this trend window.
							</p>
						)}
					</section>
				</div>
			) : null}
		</section>
	);
};
