import type React from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TeamMemberSummary } from '../../services/teamService';
import { ReportsWeeklyView } from '../components/reports/ReportsWeeklyView';
import { toast } from '../components/ui/Toast';
import { usePageTitle } from '../hooks/usePageTitle';
import type {
	ReportsSortDirection,
	ReportsSortField,
} from '../hooks/useReportsURLState';
import { downloadAsFile } from '../utils/downloadFile';
import { buildTeamCsv } from '../utils/teamCsvExport';
import * as styles from './DemoPage.module.css';
import { buildDemoTeam, DEMO_WEEK_START, DEMO_WEEKDAYS } from './demoFixture';

// Built once at module load — the demo data never changes at runtime.
const DEMO_TEAM = buildDemoTeam();

function sortDemoMembers(
	members: TeamMemberSummary[],
	field: ReportsSortField,
	direction: ReportsSortDirection,
): TeamMemberSummary[] {
	const sorted = [...members].sort((a, b) => {
		let cmp: number;
		switch (field) {
			case 'total':
				cmp = a.totalSeconds - b.totalSeconds;
				break;
			case 'gap':
				cmp = a.gapSeconds - b.gapSeconds;
				break;
			default:
				cmp = a.displayName.localeCompare(b.displayName);
		}
		return direction === 'desc' ? -cmp : cmp;
	});
	return sorted;
}

export const DemoPage: React.FC = () => {
	usePageTitle('Demo');

	// Default to gap-descending so the teammate most behind sits at the top —
	// that's the chase-your-team's-missing-hours moment the demo exists to show.
	const [sortField, setSortField] = useState<ReportsSortField>('gap');
	const [sortDirection, setSortDirection] =
		useState<ReportsSortDirection>('desc');

	const sortedMembers = useMemo(
		() => sortDemoMembers(DEMO_TEAM, sortField, sortDirection),
		[sortField, sortDirection],
	);

	const weeklySummary = useMemo(
		() => ({
			totalSeconds: DEMO_TEAM.reduce((sum, m) => sum + m.totalSeconds, 0),
			totalGapSeconds: DEMO_TEAM.reduce((sum, m) => sum + m.gapSeconds, 0),
		}),
		[],
	);

	const handleSort = (field: ReportsSortField) => {
		if (sortField === field) {
			setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		} else {
			setSortField(field);
			setSortDirection('asc');
		}
	};

	const handleMemberClick = () => {
		toast.info(
			'This is demo data — connect your own Jira to drill into a person’s month.',
		);
	};

	const handleExportCsv = () => {
		const csv = buildTeamCsv(sortedMembers, DEMO_WEEKDAYS, {
			includeProvenance: false,
		});
		downloadAsFile(csv, 'hoursmith-demo-team.csv', 'text/csv;charset=utf-8');
		toast.success('Demo CSV exported');
	};

	return (
		<div className={styles.container}>
			<div className={styles.banner}>
				<span className={styles.bannerText}>
					Demo data — read-only. <Link to="/pricing">Get Hoursmith</Link> to
					connect your own Jira.
				</span>
				<button
					type="button"
					className={styles.exportButton}
					onClick={handleExportCsv}
				>
					Export CSV
				</button>
			</div>

			<header className={styles.header}>
				<h1 className={styles.title}>Team rollup — week of May 18</h1>
				<p className={styles.subtitle}>
					Who logged what, where the gaps are, and the missed days to chase
					before invoice day. This is exactly the view a team lead sees against
					their own Jira.
				</p>
			</header>

			<ReportsWeeklyView
				teamMembers={DEMO_TEAM}
				sortedMembers={sortedMembers}
				weekStart={DEMO_WEEK_START}
				weekLoading={false}
				weekFetching={false}
				teamError={null}
				teamLoadingProgress={null}
				sortField={sortField}
				sortDirection={sortDirection}
				onSort={handleSort}
				managerMode={false}
				trendWeeks={6}
				setTrendWeeks={() => {}}
				trendModel={undefined}
				trendsLoading={false}
				trendsError={null}
				hasNoFilteredWeeklyResults={false}
				weeklySummary={weeklySummary}
				onMemberClick={handleMemberClick}
			/>
		</div>
	);
};
