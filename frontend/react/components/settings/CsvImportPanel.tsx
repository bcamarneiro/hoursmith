import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
	type ColumnMapping,
	type MappingResult,
	type ToolPreset,
	type WorklogDraft,
	detectPreset,
	mapRowsToDrafts,
} from '../../../services/csvImportService';
import { parseCsv } from '../../utils/csvImportParser';
import { Button } from '../ui/Button';
import * as styles from './CsvImportPanel.module.css';

type ImportPhase = 'upload' | 'preview' | 'submitting' | 'done';

interface ImportState {
	phase: ImportPhase;
	fileName: string;
	headers: string[];
	rows: string[][];
	preset: ToolPreset;
	mapping: ColumnMapping;
	result: MappingResult | null;
	submitResult: { success: number; failed: string[] } | null;
	error: string | null;
}

const INITIAL_STATE: ImportState = {
	phase: 'upload',
	fileName: '',
	headers: [],
	rows: [],
	preset: 'generic',
	mapping: { date: 0, issueKey: 1, duration: 2, description: 3 },
	result: null,
	submitResult: null,
	error: null,
};

const PRESET_LABELS: Record<ToolPreset, string> = {
	toggl: 'Toggl Track',
	clockify: 'Clockify',
	harvest: 'Harvest',
	tempo: 'Tempo',
	generic: 'Generic CSV',
};

interface Props {
	/** Called when the user confirms the import. Receives the worklog drafts. */
	onImport: (drafts: WorklogDraft[]) => Promise<{
		success: number;
		failed: string[];
	}>;
}

/**
 * CSV Import Panel — upload a CSV from a time-tracking tool, preview the
 * parsed worklogs, adjust column mapping if needed, and submit to Jira.
 *
 * This is a self-contained component that can be embedded in the Settings
 * page's Integrations section or used standalone.
 */
export const CsvImportPanel: React.FC<Props> = ({ onImport }) => {
	const [state, setState] = useState<ImportState>(INITIAL_STATE);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const handleFileSelect = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;

			// Guard against oversized files that could freeze the browser
			const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
			if (file.size > MAX_FILE_SIZE) {
				setState({
					...INITIAL_STATE,
					error: `File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum size is 10 MB.`,
				});
				e.target.value = '';
				return;
			}

			const reader = new FileReader();
			reader.onload = (event) => {
				try {
					const text = event.target?.result as string;
					const parsed = parseCsv(text);
					const detection = detectPreset(parsed);

					const mapping = detection.mapping ?? {
						date: 0,
						issueKey: 1,
						duration: 2,
						description: 3,
					};

					// Clamp mapping indices to valid range
					const safeMapping: ColumnMapping = {
						date: Math.min(mapping.date, parsed.headers.length - 1),
						issueKey: Math.min(mapping.issueKey, parsed.headers.length - 1),
						duration: Math.min(mapping.duration, parsed.headers.length - 1),
						description: Math.min(
							mapping.description,
							parsed.headers.length - 1,
						),
					};

					const result = mapRowsToDrafts(parsed, safeMapping);

					setState({
						phase: 'preview',
						fileName: file.name,
						headers: parsed.headers,
						rows: parsed.rows,
						preset: detection.preset,
						mapping: safeMapping,
						result,
						submitResult: null,
						error: null,
					});
				} catch (err) {
					setState({
						...INITIAL_STATE,
						error:
							err instanceof Error
								? err.message
								: 'Failed to parse CSV file',
					});
				}
			};
			reader.onerror = () => {
				setState({
					...INITIAL_STATE,
					error: 'Failed to read file',
				});
			};
			reader.readAsText(file);

			// Reset the input so the same file can be re-selected
			e.target.value = '';
		},
		[],
	);

	const handleMappingChange = useCallback(
		(field: keyof ColumnMapping, value: number) => {
			setState((prev) => {
				const newMapping = { ...prev.mapping, [field]: value };
				const parsed = {
					headers: prev.headers,
					rows: prev.rows,
					delimiter: ',' as const,
				};
				const result = mapRowsToDrafts(parsed, newMapping);
				return {
					...prev,
					mapping: newMapping,
					result,
				};
			});
		},
		[],
	);

	const handleReset = useCallback(() => {
		setState(() => ({ ...INITIAL_STATE }));
	}, []);

	const handleSubmit = useCallback(async () => {
		if (!state.result || state.result.drafts.length === 0) return;

		setState((prev) => ({ ...prev, phase: 'submitting' }));
		try {
			const submitResult = await onImport(state.result.drafts);
			setState((prev) => ({
				...prev,
				phase: 'done',
				submitResult,
			}));
		} catch (err) {
			setState((prev) => ({
				...prev,
				phase: 'preview',
				error:
					err instanceof Error ? err.message : 'Import failed',
			}));
		}
	}, [state.result, onImport]);

	const draftCount = state.result?.drafts.length ?? 0;
	const skippedCount = state.result?.skipped.length ?? 0;

	const columnOptions = useMemo(
		() =>
			state.headers.map((h, i) => ({
				value: i,
				label: h || `Column ${i + 1}`,
			})),
		[state.headers],
	);

	if (state.phase === 'upload') {
		return (
			<div className={styles.container}>
				<div className={styles.uploadArea}>
					<p className={styles.uploadTitle}>Import worklogs from CSV</p>
					<p className={styles.uploadHint}>
						Upload a CSV export from Toggl, Clockify, Harvest, Tempo, or
						any time-tracking tool. Columns are auto-detected.
					</p>
					<input
						ref={fileInputRef}
						type="file"
						accept=".csv,text/csv"
						onChange={handleFileSelect}
						className={styles.fileInput}
						data-testid="csv-file-input"
					/>
					<Button
						type="button"
						variant="secondary"
						onClick={() => fileInputRef.current?.click()}
					>
						Choose CSV file
					</Button>
					{state.error && (
						<p className={styles.error} data-testid="csv-import-error">
							{state.error}
						</p>
					)}
				</div>
				<details className={styles.supportedFormats}>
					<summary>Supported formats</summary>
					<ul>
						<li>
							<strong>Toggl Track</strong> — Description, Duration, Date,
							Project
						</li>
						<li>
							<strong>Clockify</strong> — Project, Description, Date,
							Duration
						</li>
						<li>
							<strong>Harvest</strong> — Date, Hours, Notes, Project
						</li>
						<li>
							<strong>Tempo</strong> — Date, Issue Key, Time Spent,
							Description
						</li>
						<li>
							<strong>Generic CSV</strong> — any file with date, issue key,
							duration, and description columns
						</li>
					</ul>
					<p>
						Durations can be in <code>1h 30m</code>, <code>1.5h</code>,{' '}
						<code>90m</code>, or <code>01:30:00</code> format. Issue keys are
						extracted from any column (e.g. "PROJ-123").
					</p>
				</details>
			</div>
		);
	}

	if (state.phase === 'done') {
		return (
			<div className={styles.container}>
				<div className={styles.doneArea}>
					<p className={styles.doneTitle}>Import complete</p>
					{state.submitResult && (
						<p>
							{state.submitResult.success} worklog
							{state.submitResult.success !== 1 ? 's' : ''} created
							successfully.
							{state.submitResult.failed.length > 0 && (
								<>
									{' '}
									{state.submitResult.failed.length} failed:{' '}
									{state.submitResult.failed.join(', ')}
								</>
							)}
						</p>
					)}
					<Button type="button" variant="secondary" onClick={handleReset}>
						Import another file
					</Button>
				</div>
			</div>
		);
	}

	// Preview phase (and submitting)
	return (
		<div className={styles.container}>
			<div className={styles.previewHeader}>
				<div>
					<p className={styles.fileName}>{state.fileName}</p>
					<p className={styles.presetBadge}>
						Detected: {PRESET_LABELS[state.preset]}
					</p>
				</div>
				<Button type="button" variant="secondary" onClick={handleReset}>
					Cancel
				</Button>
			</div>

			<div className={styles.mappingSection}>
				<p className={styles.mappingTitle}>Column mapping</p>
				<div className={styles.mappingGrid}>
					<label className={styles.mappingField}>
						<span>Date</span>
						<select
							value={state.mapping.date}
							onChange={(e) =>
								handleMappingChange('date', Number(e.target.value))
							}
							data-testid="mapping-date"
						>
							{columnOptions.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</label>
					<label className={styles.mappingField}>
						<span>Issue key</span>
						<select
							value={state.mapping.issueKey}
							onChange={(e) =>
								handleMappingChange('issueKey', Number(e.target.value))
							}
							data-testid="mapping-issue-key"
						>
							{columnOptions.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</label>
					<label className={styles.mappingField}>
						<span>Duration</span>
						<select
							value={state.mapping.duration}
							onChange={(e) =>
								handleMappingChange('duration', Number(e.target.value))
							}
							data-testid="mapping-duration"
						>
							{columnOptions.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</label>
					<label className={styles.mappingField}>
						<span>Description</span>
						<select
							value={state.mapping.description}
							onChange={(e) =>
								handleMappingChange('description', Number(e.target.value))
							}
							data-testid="mapping-description"
						>
							{columnOptions.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</label>
				</div>
			</div>

			<div className={styles.summaryRow}>
				<span className={styles.summaryOk}>
					{draftCount} worklog{draftCount !== 1 ? 's' : ''} ready
				</span>
				{skippedCount > 0 && (
					<span className={styles.summarySkip}>
						{skippedCount} row{skippedCount !== 1 ? 's' : ''} skipped
					</span>
				)}
			</div>

			{state.result && state.result.drafts.length > 0 && (
				<div className={styles.previewTable}>
					<table>
						<thead>
							<tr>
								<th>Date</th>
								<th>Issue</th>
								<th>Time</th>
								<th>Comment</th>
							</tr>
						</thead>
						<tbody>
							{state.result.drafts.slice(0, 20).map((draft, i) => (
								<tr key={i}>
									<td>{draft.started}</td>
									<td>{draft.issueKey}</td>
									<td>{draft.timeSpent}</td>
									<td className={styles.commentCell}>{draft.comment}</td>
								</tr>
							))}
						</tbody>
					</table>
					{draftCount > 20 && (
						<p className={styles.moreRows}>
							…and {draftCount - 20} more rows
						</p>
					)}
				</div>
			)}

			{state.result && state.result.skipped.length > 0 && (
				<details className={styles.skippedDetails}>
					<summary>
						{skippedCount} skipped row{skippedCount !== 1 ? 's' : ''}
					</summary>
					<ul className={styles.skippedList}>
						{state.result.skipped.map((s) => (
							<li key={s.rowIndex}>
								Row {s.rowIndex}: {s.reason}
							</li>
						))}
					</ul>
				</details>
			)}

			{state.error && (
				<p className={styles.error} data-testid="csv-import-error">
					{state.error}
				</p>
			)}

			<div className={styles.actions}>
				<Button
					type="button"
					variant="primary"
					onClick={handleSubmit}
					disabled={
						state.phase === 'submitting' || draftCount === 0
					}
					data-testid="csv-import-submit"
				>
					{state.phase === 'submitting'
						? 'Importing...'
						: `Import ${draftCount} worklog${draftCount !== 1 ? 's' : ''}`}
				</Button>
			</div>
		</div>
	);
};
