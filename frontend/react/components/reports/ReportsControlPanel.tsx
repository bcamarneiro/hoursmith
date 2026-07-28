import type React from 'react';
import { useState } from 'react';
import type { ReportPreset } from '../../../stores/useUserDataStore';
import type {
	ReportsSortDirection,
	ReportsSortField,
	ReportsViewMode,
} from '../../hooks/useReportsURLState';
import type { FreshnessTone } from '../../utils/dataFreshness';
import { Button } from '../ui/Button';
import * as styles from './ReportsControlPanel.module.css';

type ValidationState = {
	status: 'idle' | 'checking' | 'consistent' | 'inconsistent' | 'error';
	message: string;
	checkedAt: string | null;
	mismatches: Array<{
		displayName: string;
		weeklySeconds: number;
		monthlySeconds: number;
	}>;
};

type Props = {
	viewMode: ReportsViewMode;
	selectedUserLabel: string | null;
	monthlyUserCount: number;
	searchQuery: string;
	onlyAttentionNeeded: boolean;
	managerMode: boolean;
	trendWeeks: number;
	sortField: ReportsSortField;
	sortDirection: ReportsSortDirection;
	presets: ReportPreset[];
	defaultPresetId: string | null;
	onSearchChange: (value: string) => void;
	onOnlyAttentionNeededChange: (value: boolean) => void;
	onManagerModeChange: (value: boolean) => void;
	onTrendWeeksChange: (value: number) => void;
	onClearFilters: () => void;
	onSavePreset: (label: string) => void;
	onApplyPreset: (preset: ReportPreset) => void;
	onRemovePreset: (id: string) => void;
	onSetDefaultPreset: (id: string | null) => void;
	onCopyShareLink: () => Promise<void> | void;
	onExportSnapshotHtml: () => void;
	onExportSnapshotMarkdown: () => void;
	onExportPrimary: () => void;
	onValidateConsistency: () => Promise<void> | void;
	validationState: ValidationState;
	primaryExportLabel: string | null;
	canExportPrimary: boolean;
	canValidate: boolean;
	canExportSnapshot: boolean;
	dataFreshnessLabel: string;
	dataFreshnessDetail: string;
	dataFreshnessTone: FreshnessTone;
};

const validationToneMap = {
	idle: styles.validationIdle,
	checking: styles.validationChecking,
	consistent: styles.validationConsistent,
	inconsistent: styles.validationInconsistent,
	error: styles.validationError,
} as const;

export const ReportsControlPanel: React.FC<Props> = ({
	viewMode,
	selectedUserLabel,
	monthlyUserCount,
	searchQuery,
	onlyAttentionNeeded,
	managerMode,
	trendWeeks,
	sortField,
	sortDirection,
	presets,
	defaultPresetId,
	onSearchChange,
	onOnlyAttentionNeededChange,
	onManagerModeChange,
	onTrendWeeksChange,
	onClearFilters,
	onSavePreset,
	onApplyPreset,
	onRemovePreset,
	onSetDefaultPreset,
	onCopyShareLink,
	onExportSnapshotHtml,
	onExportSnapshotMarkdown,
	onExportPrimary,
	onValidateConsistency,
	validationState,
	primaryExportLabel,
	canExportPrimary,
	canValidate,
	canExportSnapshot,
	dataFreshnessLabel,
	dataFreshnessDetail,
	dataFreshnessTone,
}) => {
	const [presetName, setPresetName] = useState('');
	const isWeekly = viewMode === 'weekly';
	const freshnessToneClass =
		dataFreshnessTone === 'fresh'
			? styles.freshnessFresh
			: dataFreshnessTone === 'warning'
				? styles.freshnessWarning
				: dataFreshnessTone === 'stale'
					? styles.freshnessStale
					: styles.freshnessIdle;

	return (
		<section className={styles.panel} aria-labelledby="reports-controls-title">
			<div className={styles.header}>
				<div>
					<p className={styles.kicker}>Reports controls</p>
					<h2 id="reports-controls-title">
						Filter, share, and validate this view
					</h2>
					<p className={styles.description}>
						{isWeekly
							? 'Weekly filters stay local to this team surface. Share links preserve the current state, and presets let you reuse the same attention and trend views without rebuilding them every time.'
							: 'Monthly focus stays local to the current month. Share links preserve the current state, and presets let you jump back to the same reporting focus without rebuilding it every time.'}
					</p>
					<div className={styles.freshnessRow}>
						<span className={`${styles.freshnessBadge} ${freshnessToneClass}`}>
							{dataFreshnessLabel}
						</span>
						<span className={styles.freshnessDetail}>
							{dataFreshnessDetail}
						</span>
					</div>
				</div>
				<div className={styles.headerActions}>
					{primaryExportLabel ? (
						<Button
							type="button"
							variant="secondary"
							onClick={onExportPrimary}
							disabled={!canExportPrimary}
						>
							{primaryExportLabel}
						</Button>
					) : null}
					<Button
						type="button"
						variant="secondary"
						onClick={() => {
							void onCopyShareLink();
						}}
					>
						Copy share link
					</Button>
					<Button
						type="button"
						variant="secondary"
						onClick={onExportSnapshotHtml}
						disabled={!canExportSnapshot}
					>
						Snapshot HTML
					</Button>
					<Button
						type="button"
						variant="secondary"
						onClick={onExportSnapshotMarkdown}
						disabled={!canExportSnapshot}
					>
						Snapshot MD
					</Button>
					{isWeekly ? (
						<Button
							type="button"
							variant="secondary"
							onClick={() => {
								void onValidateConsistency();
							}}
							disabled={!canValidate || validationState.status === 'checking'}
						>
							{validationState.status === 'checking'
								? 'Checking consistency...'
								: 'Run consistency check'}
						</Button>
					) : null}
				</div>
			</div>

			{isWeekly ? (
				<>
					<div className={styles.filtersRow}>
						<label className={styles.searchField}>
							<span>Filter people</span>
							<input
								type="search"
								value={searchQuery}
								onChange={(event) => onSearchChange(event.target.value)}
								placeholder="Search by team member or email"
							/>
						</label>
						<div className={styles.weeklyToggles}>
							<label
								className={`${styles.toggleCard} ${onlyAttentionNeeded ? styles.toggleCardActive : ''}`}
							>
								<input
									type="checkbox"
									checked={onlyAttentionNeeded}
									onChange={(event) =>
										onOnlyAttentionNeededChange(event.target.checked)
									}
								/>
								<div>
									<span>Needs attention only</span>
									<small>
										Show only people who still have a gap this week.
									</small>
								</div>
							</label>
							<label
								className={`${styles.toggleCard} ${managerMode ? styles.toggleCardActive : ''}`}
							>
								<input
									type="checkbox"
									checked={managerMode}
									onChange={(event) =>
										onManagerModeChange(event.target.checked)
									}
								/>
								<div>
									<span>Manager mode</span>
									<small>
										Add multi-week compliance trends and recurring-gap signals.
									</small>
								</div>
							</label>
							{managerMode ? (
								<label className={styles.trendField}>
									<span>Trend window</span>
									<select
										value={trendWeeks}
										onChange={(event) =>
											onTrendWeeksChange(
												Number.parseInt(event.target.value, 10),
											)
										}
									>
										<option value={4}>4 weeks</option>
										<option value={6}>6 weeks</option>
										<option value={8}>8 weeks</option>
										<option value={12}>12 weeks</option>
									</select>
								</label>
							) : null}
						</div>
						<div className={styles.filterMeta}>
							<span>
								Sort: {sortField} ({sortDirection})
							</span>
							<Button
								type="button"
								variant="secondary"
								onClick={onClearFilters}
							>
								Clear filters
							</Button>
						</div>
					</div>

					<div className={styles.validationBox}>
						<div className={styles.validationHeader}>
							<strong>In-app consistency check</strong>
							<span
								className={`${styles.validationBadge} ${validationToneMap[validationState.status]}`}
							>
								{validationState.status}
							</span>
						</div>
						<p>{validationState.message}</p>
						{validationState.checkedAt ? (
							<span className={styles.validationTimestamp}>
								Last checked: {validationState.checkedAt}
							</span>
						) : null}
						{validationState.mismatches.length > 0 ? (
							<ul className={styles.mismatchList}>
								{validationState.mismatches.slice(0, 3).map((mismatch) => (
									<li key={mismatch.displayName}>
										<strong>{mismatch.displayName}</strong>: weekly{' '}
										{(mismatch.weeklySeconds / 3600).toFixed(1)}h vs monthly{' '}
										{(mismatch.monthlySeconds / 3600).toFixed(1)}h
									</li>
								))}
							</ul>
						) : null}
					</div>
				</>
			) : (
				<div className={styles.monthlyFocusCard}>
					<div>
						<strong>Monthly focus</strong>
						<p>
							Use the user dropdown beside the month navigator to focus one
							person. Exports follow the current focus.
						</p>
					</div>
					<div className={styles.monthlyFocusMeta}>
						<span>
							Current focus:{' '}
							<strong>
								{selectedUserLabel || `All users (${monthlyUserCount})`}
							</strong>
						</span>
						<Button type="button" variant="secondary" onClick={onClearFilters}>
							Show all users
						</Button>
					</div>
				</div>
			)}

			<div className={styles.presetsSection}>
				<div className={styles.presetsHeader}>
					<div>
						<strong>Saved presets</strong>
						<p>
							{viewMode === 'weekly'
								? 'Presets keep reusable filters such as attention-only views or a manager-focused weekly view with a fixed trend window.'
								: 'Presets keep reusable monthly focuses so you can jump back to the same people and surface quickly.'}
						</p>
					</div>
					<div className={styles.presetComposer}>
						<input
							type="text"
							value={presetName}
							onChange={(event) => setPresetName(event.target.value)}
							placeholder="Preset name"
						/>
						<Button
							type="button"
							onClick={() => {
								onSavePreset(presetName);
								setPresetName('');
							}}
							disabled={!presetName.trim()}
						>
							Save preset
						</Button>
					</div>
				</div>

				{presets.length > 0 ? (
					<div className={styles.presetList}>
						{presets.map((preset) => {
							const isDefault = defaultPresetId === preset.id;
							return (
								<div key={preset.id} className={styles.presetChip}>
									<button
										type="button"
										className={styles.presetDefault}
										onClick={() => onSetDefaultPreset(isDefault ? null : preset.id)}
										title={isDefault ? 'Unset as default preset' : 'Set as default preset'}
										aria-label={isDefault ? 'Unset as default preset' : 'Set as default preset'}
									>
										{isDefault ? '★' : '☆'}
									</button>
									<button
										type="button"
										className={styles.presetApply}
										onClick={() => onApplyPreset(preset)}
									>
										<span>{preset.label}</span>
										<small>{preset.viewMode}</small>
									</button>
									<button
										type="button"
										className={styles.presetRemove}
										onClick={() => onRemovePreset(preset.id)}
										aria-label={`Remove preset ${preset.label}`}
									>
										&times;
									</button>
								</div>
							);
						})}
					</div>
				) : (
					<p className={styles.emptyPresets}>
						No saved presets yet. Save one after you build a useful reports
						view.
					</p>
				)}
			</div>
		</section>
	);
};
