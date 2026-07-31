import type React from 'react';
import { useId, useState } from 'react';
import { formatDateTimeLocalValue, withLocalOffset } from '../../utils/date';
import { isValidTimeSpentFormat } from '../../utils/timeSpent';
import { Button } from '../ui/Button';
import { CommentPresets } from './CommentPresets';
import * as formStyles from './WorklogForm.module.css';
import * as recentStyles from './AtividadeRecente.module.css';

type RecentActivity = {
	issueKey: string;
	issueSummary?: string;
	timeSpent: string;
	started: string;
};

type Props = {
	initialData?: {
		issueKey: string;
		timeSpent: string;
		comment: string;
		started: string;
	};
	onSubmit: (data: {
		issueKey: string;
		timeSpent: string;
		comment: string;
		started: string;
	}) => Promise<void>;
	onCancel: () => void;
	isEdit?: boolean;
	isLoading?: boolean;
	recentActivities?: RecentActivity[];
};

export const WorklogForm: React.FC<Props> = ({
	initialData,
	onSubmit,
	onCancel,
	isEdit = false,
	isLoading = false,
	recentActivities,
}) => {
	const issueKeyId = useId();
	const timeSpentId = useId();
	const startedId = useId();
	const commentId = useId();
	const [issueKey, setIssueKey] = useState(initialData?.issueKey || '');
	const [timeSpent, setTimeSpent] = useState(initialData?.timeSpent || '');
	const [comment, setComment] = useState(initialData?.comment || '');
	const [started, setStarted] = useState(
		initialData?.started || formatDateTimeLocalValue(new Date()),
	);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		// Validation
		if (!issueKey.trim()) {
			setError('Issue key is required');
			return;
		}

		if (!timeSpent.trim()) {
			setError('Time spent is required');
			return;
		}

		// Validate time format (e.g., 1h, 30m, 1h 30m, 2d)
		if (!isValidTimeSpentFormat(timeSpent)) {
			setError(
				'Invalid time format. Use formats like: 1h, 30m, 1h 30m, 2d, etc.',
			);
			return;
		}

		try {
			await onSubmit({
				issueKey: issueKey.trim().toUpperCase(),
				timeSpent: timeSpent.trim(),
				comment: comment.trim(),
				started: withLocalOffset(started),
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save worklog');
		}
	};

	const handlePresetSelect = (text: string) => {
		setComment((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
	};

	return (
		<form onSubmit={handleSubmit} className={formStyles.form}>
			{recentActivities && recentActivities.length > 0 && (
				<div className={recentStyles.section}>
					<span className={recentStyles.title}>Atividade Recente</span>
					<div className={recentStyles.list}>
						{recentActivities.map((a, i) => (
							<button
								key={`${a.issueKey}-${i}`}
								type="button"
								className={recentStyles.item}
								onClick={() => {
									setIssueKey(a.issueKey);
									setTimeSpent(a.timeSpent);
									setStarted(a.started);
								}}
								title={`Fill form with ${a.issueKey} (${a.timeSpent})`}
								aria-label={`Fill form with ${a.issueKey}, ${a.timeSpent}`}
							>
								<span className={recentStyles.itemKey}>{a.issueKey}</span>
								{a.issueSummary && (
									<span className={recentStyles.itemSummary}>
										{a.issueSummary}
									</span>
								)}
								<span className={recentStyles.itemTime}>{a.timeSpent}</span>
							</button>
						))}
					</div>
				</div>
			)}

			<div className={formStyles.formGroup}>
				<label htmlFor={issueKeyId}>
					Issue Key <span className={formStyles.required}>*</span>
				</label>
				<input
					type="text"
					id={issueKeyId}
					value={issueKey}
					onChange={(e) => setIssueKey(e.target.value)}
					placeholder="e.g., PROJ-123"
					disabled={isEdit || isLoading}
					className={formStyles.input}
					autoCapitalize="characters"
					autoCorrect="off"
					spellCheck={false}
					required
				/>
				<small className={formStyles.hint}>
					The Jira issue key (e.g., PROJ-123)
				</small>
			</div>

			<div className={formStyles.formGroup}>
				<label htmlFor={timeSpentId}>
					Time Spent <span className={formStyles.required}>*</span>
				</label>
				<input
					type="text"
					id={timeSpentId}
					value={timeSpent}
					onChange={(e) => setTimeSpent(e.target.value)}
					placeholder="e.g., 1h 30m"
					disabled={isLoading}
					className={formStyles.input}
					inputMode="text"
					autoCorrect="off"
					spellCheck={false}
					required
				/>
				<small className={formStyles.hint}>
					Format: 1h, 30m, 1h 30m, 2d, etc.
				</small>
			</div>

			<div className={formStyles.formGroup}>
				<label htmlFor={startedId}>Started</label>
				<input
					type="datetime-local"
					id={startedId}
					value={started}
					onChange={(e) => setStarted(e.target.value)}
					disabled={isLoading}
					className={formStyles.input}
				/>
			</div>

			<div className={formStyles.formGroup}>
				<label htmlFor={commentId}>Description (Optional)</label>
				<CommentPresets onSelect={handlePresetSelect} />
				<textarea
					id={commentId}
					value={comment}
					onChange={(e) => setComment(e.target.value)}
					placeholder="Add a description of the work done..."
					rows={4}
					disabled={isLoading}
					className={formStyles.textarea}
				/>
			</div>

			{error && <div className={formStyles.error}>{error}</div>}

			<div className={formStyles.actions}>
				<Button
					type="button"
					onClick={onCancel}
					variant="secondary"
					disabled={isLoading}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={isLoading}>
					{isLoading ? 'Saving...' : isEdit ? 'Update' : 'Create'} Worklog
				</Button>
			</div>
		</form>
	);
};
