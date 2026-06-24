import type React from 'react';
import { useConfigStore } from '../../../stores/useConfigStore';
import { useDashboardStore } from '../../../stores/useDashboardStore';
import { describeFreshness } from '../../utils/dataFreshness';
import * as styles from './SourceStatusBar.module.css';

export const SourceStatusBar: React.FC = () => {
	const config = useConfigStore((s) => s.config);
	const isLoadingJira = useDashboardStore((s) => s.isLoadingJiraSuggestions);
	const isLoadingGitlab = useDashboardStore(
		(s) => s.isLoadingGitlabSuggestions,
	);
	const isLoadingGithub = useDashboardStore(
		(s) => s.isLoadingGithubSuggestions,
	);
	const isLoadingCalendar = useDashboardStore(
		(s) => s.isLoadingCalendarSuggestions,
	);
	const isLoadingRescueTime = useDashboardStore((s) => s.isLoadingRescueTime);
	const jiraError = useDashboardStore((s) => s.jiraSuggestionsError);
	const gitlabError = useDashboardStore((s) => s.gitlabSuggestionsError);
	const githubError = useDashboardStore((s) => s.githubSuggestionsError);
	const calendarError = useDashboardStore((s) => s.calendarSuggestionsError);
	const rescueTimeError = useDashboardStore((s) => s.rescueTimeError);
	const lastFetchedAt = useDashboardStore((s) => s.lastFetchedAt);

	const hasGitlab = !!(config.gitlabToken && config.gitlabHost);
	const hasGithub = !!config.githubToken;
	const hasCalendar = (config.calendarFeeds ?? []).some(
		(feed) => feed.type === 'suggestion' && feed.url.trim(),
	);
	const hasRescueTime = !!config.rescueTimeApiKey;

	// Only show configured sources
	const sources: Array<{
		label: string;
		loading: boolean;
		error: string | null;
	}> = [{ label: 'Jira', loading: isLoadingJira, error: jiraError }];

	if (hasGitlab)
		sources.push({
			label: 'GitLab',
			loading: isLoadingGitlab,
			error: gitlabError,
		});
	if (hasGithub)
		sources.push({
			label: 'GitHub',
			loading: isLoadingGithub,
			error: githubError,
		});
	if (hasCalendar)
		sources.push({
			label: 'Calendar',
			loading: isLoadingCalendar,
			error: calendarError,
		});
	if (hasRescueTime)
		sources.push({
			label: 'RescueTime',
			loading: isLoadingRescueTime,
			error: rescueTimeError,
		});

	const hasErrors = sources.some((s) => s.error);
	const isAnyLoading = sources.some((s) => s.loading);
	const freshness = isAnyLoading
		? {
				label: 'Syncing dashboard…',
				detail: 'Refreshing dashboard sources now.',
				tone: 'warning' as const,
			}
		: describeFreshness(lastFetchedAt);
	const freshnessClass =
		freshness.tone === 'fresh'
			? styles.metaFresh
			: freshness.tone === 'warning'
				? styles.metaWarning
				: freshness.tone === 'stale'
					? styles.metaStale
					: styles.metaIdle;
	const tooltip = buildTooltip(sources, freshness.detail);

	return (
		<output className={styles.container} title={tooltip} aria-live="polite">
			{hasErrors ? (
				// Expanded: show error labels
				sources
					.filter((s) => s.error)
					.map((s) => (
						<span
							key={s.label}
							className={`${styles.pill} ${styles.error}`}
							title={s.error || ''}
						>
							{s.label} error
						</span>
					))
			) : (
				// Compact: just dots
				<div className={styles.dots} aria-hidden="true">
					{sources.map((s) => (
						<span
							key={s.label}
							className={`${styles.dot} ${s.loading ? styles.dotLoading : styles.dotOk}`}
							title={`${s.label}: ${s.loading ? 'syncing' : 'connected'}`}
						/>
					))}
					{isAnyLoading && <span className={styles.loadingLabel}>Syncing</span>}
				</div>
			)}
			<span className={`${styles.meta} ${freshnessClass}`}>
				{freshness.label}
			</span>
		</output>
	);
};

function buildTooltip(
	sources: Array<{ label: string; loading: boolean; error: string | null }>,
	freshnessDetail: string,
): string {
	return [
		...sources.map((s) => {
			if (s.loading) return `${s.label}: syncing...`;
			if (s.error) return `${s.label}: ${s.error}`;
			return `${s.label}: connected`;
		}),
		freshnessDetail,
	].join('\n');
}
