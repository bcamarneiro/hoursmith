import type React from 'react';
import type {
	WeeklyCloseAction,
	WeeklyCloseAssistantModel,
	WeeklyCloseStatus,
} from '../../utils/weeklyCloseAssistant';
import { formatHours } from '../../utils/format';
import { Button } from '../ui/Button';
import { ProgressBar } from '../ui/ProgressBar';
import * as styles from './WeeklyCloseAssistant.module.css';

type Props = {
	model: WeeklyCloseAssistantModel;
	canExport: boolean;
	isCopyingPrevWeek: boolean;
	onJumpToGapDays: () => void;
	onCopyPrevWeek: () => Promise<void> | void;
	onCopySummary: () => Promise<void> | void;
	onExportCsv: () => void;
	onEnableReminders: () => void;
};

const statusLabelMap: Record<WeeklyCloseStatus, string> = {
	ready: 'Ready',
	warning: 'Needs focus',
	pending: 'Pending',
};

const statusClassMap: Record<WeeklyCloseStatus, string> = {
	ready: styles.statusReady,
	warning: styles.statusWarning,
	pending: styles.statusPending,
};

function getPrimaryAction(
	model: WeeklyCloseAssistantModel,
	isCopyingPrevWeek: boolean,
): { actionId: WeeklyCloseAction | undefined; label: string } | null {
	// Find the first warning item with an action — that's the primary focus
	const warningItem = model.items.find(
		(item) => item.status === 'warning' && item.actionId,
	);
	if (warningItem) {
		return {
			actionId: warningItem.actionId,
			label: getActionLabel(warningItem.actionId, isCopyingPrevWeek) || 'Take action',
		};
	}
	return null;
}

function getActionLabel(
	actionId: WeeklyCloseAction | undefined,
	isCopyingPrevWeek: boolean,
): string | null {
	if (!actionId) return null;
	if (actionId === 'jump-gap-days') return 'Open gap days';
	if (actionId === 'copy-summary') return 'Copy summary';
	if (actionId === 'enable-reminders') return 'Enable reminders';
	return isCopyingPrevWeek ? 'Copying...' : 'Copy previous week';
}

export const WeeklyCloseAssistant: React.FC<Props> = ({
	model,
	canExport,
	isCopyingPrevWeek,
	onJumpToGapDays,
	onCopyPrevWeek,
	onCopySummary,
	onExportCsv,
	onEnableReminders,
}) => {
	const handleAction = (actionId: WeeklyCloseAction | undefined) => {
		if (!actionId) return;
		if (actionId === 'jump-gap-days') {
			onJumpToGapDays();
			return;
		}
		if (actionId === 'copy-summary') {
			void onCopySummary();
			return;
		}
		if (actionId === 'enable-reminders') {
			onEnableReminders();
			return;
		}
		void onCopyPrevWeek();
	};

	const primaryAction = getPrimaryAction(model, isCopyingPrevWeek);
	const gapDisplay = model.gapHours > 0 ? formatHours(model.gapHours * 3600) : '0h';

	return (
		<section className={styles.panel} aria-labelledby="weekly-close-assistant">
			<div className={styles.heroSection}>
				<div className={styles.heroContent}>
					<p className={styles.kicker}>Close assistant</p>
					<h2 id="weekly-close-assistant">{model.headline}</h2>
					<p className={styles.description}>{model.detail}</p>
				</div>
				<div className={styles.heroStat}>
					<span className={styles.statLabel}>Remaining gap</span>
					<span className={styles.statValue} data-num>
						{gapDisplay}
					</span>
				</div>
			</div>

			<div className={styles.progressSection}>
				<div className={styles.progressHeader}>
					<div>
						<strong>
							{model.progress.completed} of {model.progress.total} checks in a
							good state
						</strong>
						<p>
							The goal here is not perfection. It is a short, trustworthy
							checklist before you call the week done.
						</p>
					</div>
					<span
						className={`${styles.statusBadge} ${statusClassMap[model.status]}`}
					>
						{statusLabelMap[model.status]}
					</span>
				</div>
				<ProgressBar value={model.progress.percent} height={8} />
			</div>

			<div className={styles.actionSection}>
				{primaryAction && (
					<Button
						type="button"
						variant="primary"
						onClick={() => handleAction(primaryAction.actionId)}
						disabled={
							primaryAction.actionId === 'copy-prev-week' && isCopyingPrevWeek
						}
					>
						{primaryAction.label}
					</Button>
				)}
				<div className={styles.secondaryActions}>
					<Button
						type="button"
						variant="secondary"
						onClick={() => {
							void onCopySummary();
						}}
						disabled={!canExport}
					>
						Copy summary
					</Button>
					<Button
						type="button"
						variant="secondary"
						onClick={onExportCsv}
						disabled={!canExport}
					>
						Export CSV
					</Button>
				</div>
			</div>

			<div className={styles.grid}>
				{model.items.map((item) => {
					const actionLabel = getActionLabel(item.actionId, isCopyingPrevWeek);
					return (
						<article key={item.id} className={styles.card}>
							<div className={styles.cardHeader}>
								<h3>{item.title}</h3>
								<span
									className={`${styles.statusBadge} ${statusClassMap[item.status]}`}
								>
									{statusLabelMap[item.status]}
								</span>
							</div>
							<p>{item.detail}</p>
							{actionLabel ? (
								<Button
									type="button"
									variant="secondary"
									onClick={() => handleAction(item.actionId)}
									disabled={
										item.actionId === 'copy-prev-week' && isCopyingPrevWeek
									}
								>
									{actionLabel}
								</Button>
							) : null}
						</article>
					);
				})}
			</div>
		</section>
	);
};
