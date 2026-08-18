import type React from 'react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { trackEvent } from '../../analytics';
import { useConfigStore } from '../../stores/useConfigStore';
import { useDashboardStore } from '../../stores/useDashboardStore';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { toast } from '../components/ui/Toast';
import { useDashboardDataFetcher } from '../hooks/useDashboardDataFetcher';
import { usePageTitle } from '../hooks/usePageTitle';
import { getStandupDateRange, generateStandupSummary } from '../utils/standupSummary';
import * as styles from './StandupPage.module.css';

export const StandupPage: React.FC = () => {
	usePageTitle('Standup');
	const { refetch: refetchDashboard } = useDashboardDataFetcher();

	const jiraHost = useConfigStore((s) => s.config.jiraHost);
	const weekWorklogs = useDashboardStore((s) => s.weekWorklogs);
	const isLoadingWorklogs = useDashboardStore((s) => s.isLoadingWorklogs);
	const worklogsError = useDashboardStore((s) => s.worklogsError);

	const standupRange = useMemo(() => getStandupDateRange(), []);

	const standupText = useMemo(
		() =>
			generateStandupSummary(
				weekWorklogs,
				standupRange.start,
				standupRange.end,
			),
		[weekWorklogs, standupRange.start, standupRange.end],
	);

	const hasWorklogs = weekWorklogs.some(
		(wl) => wl.date >= standupRange.start && wl.date <= standupRange.end,
	);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(standupText);
			trackEvent('standup_copied', { surface: 'standup_page' });
			toast.success('Standup summary copied to clipboard');
		} catch {
			toast.error('Failed to copy to clipboard');
		}
	};

	if (!jiraHost) {
		return (
			<div className={styles.container}>
				<section className={styles.emptySetup}>
					<div className={styles.emptySetupText}>
						<h2>Set up Jira before you use Standup</h2>
						<p>
							Standup pulls your logged work from yesterday (or Friday over the
							weekend) and formats it for your daily standup channel. Connect
							Jira first.
						</p>
					</div>
					<div className={styles.emptyActions}>
						<Link to="/settings" className={styles.primaryLink}>
							Start setup
						</Link>
						<Link to="/" className={styles.secondaryLink}>
							Back to Home
						</Link>
					</div>
				</section>
			</div>
		);
	}

	return (
		<div className={styles.container}>
			<div className={styles.header}>
				<div>
					<h2 className={styles.title}>Standup</h2>
					<p className={styles.subtitle}>
						What you logged on {standupRange.label}
					</p>
				</div>
				<div className={styles.headerActions}>
					<Button
						variant="secondary"
						onClick={() => refetchDashboard()}
						disabled={isLoadingWorklogs}
					>
						{isLoadingWorklogs ? 'Refreshing...' : 'Refresh'}
					</Button>
					<Button
						variant="primary"
						onClick={handleCopy}
						disabled={!hasWorklogs}
					>
						Copy
					</Button>
				</div>
			</div>

			{worklogsError && (
				<div className={styles.error}>
					<p>Unable to load worklogs. Check your settings and try again.</p>
					<Link to="/settings">Check settings</Link>
				</div>
			)}

			{isLoadingWorklogs && weekWorklogs.length === 0 && (
				<div className={styles.loading}>
					<Spinner size="md" />
					<span>Loading standup...</span>
				</div>
			)}

			{!isLoadingWorklogs && !hasWorklogs && !worklogsError && (
				<div className={styles.empty}>
					<h3>No worklogs for {standupRange.label}</h3>
					<p>
						Nothing was logged for this period. Check{' '}
						<Link to="/my-week">My Week</Link> to see the full picture.
					</p>
				</div>
			)}

			{hasWorklogs && (
				<pre className={styles.output} aria-label="Standup summary">
					{standupText}
				</pre>
			)}
		</div>
	);
};
