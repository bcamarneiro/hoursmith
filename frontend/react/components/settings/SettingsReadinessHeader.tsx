import type React from 'react';
import { useProxyBadge } from '../../hooks/useProxyBadge';
import type {
	SettingsSetupModel,
	SetupStatus,
} from '../../utils/settingsSetup';
import { Button } from '../ui/Button';
import { ProgressBar } from '../ui/ProgressBar';
import * as styles from './SettingsReadinessHeader.module.css';

/**
 * ADA-445: when the hosted Premium proxy is the active route, the shared setup
 * model (buildSettingsSetupModel) still describes traffic as "direct browser
 * access" because it only inspects `config.corsProxy` — it has no view of the
 * hosted-proxy bridge. We correct that copy here, at the presentation layer,
 * without touching the model: direct-access claims are replaced with
 * "Connected via the Hosted proxy".
 */
function applyHostedProxyCopy(model: SettingsSetupModel): SettingsSetupModel {
	const hostedNote = 'Connected via the Hosted proxy.';
	const rewriteDetail = (detail: string): string =>
		/direct browser access/i.test(detail)
			? detail.replace(
					/Direct browser access is (?:already )?working[^.]*\.\s*/i,
					`${hostedNote} `,
				)
			: detail;

	return {
		...model,
		steps: model.steps.map((step) =>
			step.id === 'connection'
				? { ...step, detail: rewriteDetail(step.detail) }
				: step,
		),
		diagnostics: model.diagnostics.map((diag) =>
			diag.id === 'jira'
				? { ...diag, detail: rewriteDetail(diag.detail) }
				: diag,
		),
		accessPath: {
			...model.accessPath,
			title: 'Connected via the Hosted proxy',
			summary:
				'Jira traffic is routed through the Hoursmith hosted proxy. Your token never leaves the browser unencrypted — the proxy just forwards the request to Atlassian.',
			detail: rewriteDetail(model.accessPath.detail),
		},
	};
}

/**
 * Readiness header — merges the old SetupWizard + DiagnosticsPanel into one
 * block (redesign Phase 3). Both previously read the SAME
 * `buildSettingsSetupModel(...)`; this presents that single model once instead
 * of twice. No diagnostic information is dropped — the five per-check rows now
 * surface as status dots on the section rail (see SettingsForm), and everything
 * else (headline+detail, progress X/4 + %, quick facts, the four steps, the
 * Jira access-path guidance + checklist, My Week/Reports surface readiness,
 * last-refreshed meta, Run/Refresh) lives here.
 *
 * Parity: this is a presentation merge of SetupWizard.tsx + DiagnosticsPanel.tsx
 * driven by the unchanged settingsSetup model — no field, handler, or copy
 * removed.
 */

type Props = {
	model: SettingsSetupModel;
	canRunChecks: boolean;
	checksRunning: boolean;
	lastRunAt: string | null;
	lastRunSummary: string | null;
	/** Whether the collapse toggle may be shown (core setup is done). */
	canCollapse: boolean;
	collapsed: boolean;
	onToggleCollapsed: () => void;
	onSelectSection: (sectionId: string) => void;
	onRunAvailableChecks: () => Promise<void> | void;
};

const statusLabelMap: Record<SetupStatus, string> = {
	ready: 'Ready',
	warning: 'Needs review',
	pending: 'Pending',
};

const statusClassMap: Record<SetupStatus, string> = {
	ready: styles.statusReady,
	warning: styles.statusWarning,
	pending: styles.statusPending,
};

export const SettingsReadinessHeader: React.FC<Props> = ({
	model: rawModel,
	canRunChecks,
	checksRunning,
	lastRunAt,
	lastRunSummary,
	canCollapse,
	collapsed,
	onToggleCollapsed,
	onSelectSection,
	onRunAvailableChecks,
}) => {
	// ADA-445: correct "direct access" copy when the hosted proxy is the live route.
	const proxyBadge = useProxyBadge();
	const model =
		proxyBadge.mode === 'hosted' ? applyHostedProxyCopy(rawModel) : rawModel;
	return (
		<section
			className={styles.header}
			aria-labelledby="settings-readiness-title"
		>
			<div className={styles.topRow}>
				<div className={styles.heading}>
					<p className={styles.kicker}>Setup &amp; readiness</p>
					<h2 id="settings-readiness-title">{model.headline}</h2>
					<p className={styles.detail}>{model.detail}</p>
					{lastRunAt ? (
						<p className={styles.meta}>
							Last refreshed: {lastRunAt}
							{lastRunSummary ? ` · ${lastRunSummary}` : ''}
						</p>
					) : null}
				</div>
				<div className={styles.topActions}>
					<span
						className={`${styles.statusBadge} ${statusClassMap[model.status]}`}
					>
						{statusLabelMap[model.status]}
					</span>
					{canRunChecks ? (
						<Button
							type="button"
							variant="secondary"
							onClick={onRunAvailableChecks}
							disabled={checksRunning}
						>
							{checksRunning ? 'Running checks...' : 'Run / Refresh checks'}
						</Button>
					) : null}
					{canCollapse ? (
						<Button
							type="button"
							variant="secondary"
							onClick={onToggleCollapsed}
						>
							{collapsed ? 'Show setup detail' : 'Hide setup detail'}
						</Button>
					) : null}
				</div>
			</div>

			{collapsed ? null : (
				<>
					<div className={styles.progressCard}>
						<div className={styles.progressHeader}>
							<strong>
								{model.progress.completed} of {model.progress.total} setup steps
								complete
							</strong>
							<span className={styles.percent}>{model.progress.percent}%</span>
						</div>
						<ProgressBar value={model.progress.percent} height={8} />
						<div className={styles.quickFacts}>
							<span>{model.quickFacts.allowedUsersCount} team members</span>
							<span>
								{model.quickFacts.configuredSignalCount} optional signals
							</span>
							<span>
								{model.quickFacts.suggestionFeedCount} suggestion feeds
							</span>
							<span>
								{model.quickFacts.absenceFeedCount} time off calendars
							</span>
						</div>
					</div>

					<div className={styles.stepsGrid}>
						{model.steps.map((step, index) => (
							<button
								key={step.id}
								type="button"
								className={styles.stepCard}
								onClick={() => onSelectSection(step.sectionId)}
							>
								<div className={styles.stepHeader}>
									<span className={styles.stepNumber}>{index + 1}</span>
									<div className={styles.stepTitleRow}>
										<span className={styles.stepTitle}>{step.title}</span>
										{step.optional ? (
											<span className={styles.optionalBadge}>Optional</span>
										) : null}
									</div>
									<span
										className={`${styles.dot} ${statusClassMap[step.status]}`}
										role="img"
										aria-label={statusLabelMap[step.status]}
									/>
								</div>
								<p className={styles.stepDetail}>{step.detail}</p>
							</button>
						))}
					</div>

					<article className={styles.accessCard}>
						<div className={styles.accessHeader}>
							<div>
								<p className={styles.kicker}>Jira access path</p>
								<h3>{model.accessPath.title}</h3>
								<p className={styles.detail}>{model.accessPath.summary}</p>
							</div>
							<span
								className={`${styles.statusBadge} ${statusClassMap[model.accessPath.status]}`}
							>
								{statusLabelMap[model.accessPath.status]}
							</span>
						</div>
						<p className={styles.detail}>{model.accessPath.detail}</p>
						<ul className={styles.checklist}>
							{model.accessPath.checklist.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
						<Button
							type="button"
							variant="secondary"
							onClick={() => onSelectSection(model.accessPath.sectionId)}
						>
							Open Jira connection
						</Button>
					</article>

					<div className={styles.surfaceGrid}>
						{Object.values(model.surfaces).map((surface) => (
							<article key={surface.label} className={styles.surfaceCard}>
								<div className={styles.surfaceHeader}>
									<h3>{surface.label}</h3>
									<span
										className={`${styles.statusBadge} ${statusClassMap[surface.status]}`}
									>
										{statusLabelMap[surface.status]}
									</span>
								</div>
								<p className={styles.detail}>{surface.detail}</p>
							</article>
						))}
					</div>
				</>
			)}
		</section>
	);
};
