import type React from 'react';
import type { TeamMemberSummary } from '../../../services/teamService';
import { formatHours } from '../../utils/format';
import { StatCard } from '../ui/StatCard';
import * as styles from './TeamStatsCards.module.css';

type Props = {
	teamMembers: TeamMemberSummary[];
};

export const TeamStatsCards: React.FC<Props> = ({ teamMembers }) => {
	const count = teamMembers.length;
	if (count === 0) return null;

	const totalSeconds = teamMembers.reduce((s, m) => s + m.totalSeconds, 0);
	const hasTarget = teamMembers.some((m) => m.targetSeconds > 0);
	const compliant = teamMembers.filter((m) => m.gapSeconds === 0).length;
	// Floor so a near-complete team can't show "100%" while a member still has
	// a gap (ADA-458); 100% is reserved for compliant === count.
	const complianceRate = hasTarget ? Math.floor((compliant / count) * 100) : -1;
	const avgSeconds = Math.round(totalSeconds / count);

	const complianceColor =
		complianceRate < 0
			? 'var(--color-text-tertiary)'
			: complianceRate === 100
				? 'var(--color-success)'
				: complianceRate >= 50
					? 'var(--color-warning)'
					: 'var(--color-error)';

	return (
		<div className={styles.grid}>
			<StatCard label="Total Hours" value={formatHours(totalSeconds)} />
			<StatCard
				label="Compliance"
				value={complianceRate < 0 ? '\u2014' : `${complianceRate}%`}
				valueColor={complianceColor}
			/>
			<StatCard label="Team Size" value={count} />
			<StatCard label="Avg / Member" value={formatHours(avgSeconds)} />
		</div>
	);
};
