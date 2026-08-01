import type React from 'react';
import { useId, useState } from 'react';
import { formatDateTimeLocalValue, withLocalOffset } from '../../utils/date';
import { isValidTimeSpentFormat } from '../../utils/timeSpent';
import { Button } from '../ui/Button';
import { IssueAutocomplete } from '../ui/IssueAutocomplete';
import { CommentPresets } from './CommentPresets';
import * as styles from './WorklogForm.module.css';

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
};

export const WorklogForm: React.FC<Props> = ({
	initialData,
	onSubmit,
	onCancel,
	isEdit = false,
	isLoading = false,
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
		<form onSubmit={handleSubmit} className={styles.form}>
			<div className={styles.formGroup}>
				<label htmlFor={issueKeyId}>
					Issue Key <span className={styles.required}>*</span>
				</label>
				{isEdit ? (
					<input
						type="text"
						id={issueKeyId}
						value={issueKey}
						readOnly
						disabled
						className={styles.input}
					/>
				) : (
					<IssueAutocomplete
						id={issueKeyId}
						value={issueKey}
						onChange={(value) => setIssueKey(value.toUpperCase())}
						onSelect={(issue) => setIssueKey(issue.key)}
						placeholder="e.g., PROJ-123 or search Jira"
					/>
				)}
				<small className={styles.hint}>
					The Jira issue key (e.g., PROJ-123)
				</small>
			</div>

			<div className={styles.formGroup}>
				<label htmlFor={timeSpentId}>
					Time Spent <span className={styles.required}>*</span>
				</label>
				<input
					type="text"
					id={timeSpentId}
					value={timeSpent}
					onChange={(e) => setTimeSpent(e.target.value)}
					placeholder="e.g., 1h 30m"
					disabled={isLoading}
					className={styles.input}
					inputMode="text"
					autoCorrect="off"
					spellCheck={false}
					required
				/>
				<small className={styles.hint}>Format: 1h, 30m, 1h 30m, 2d, etc.</small>
			</div>

			<div className={styles.formGroup}>
				<label htmlFor={startedId}>Started</label>
				<input
					type="datetime-local"
					id={startedId}
					value={started}
					onChange={(e) => setStarted(e.target.value)}
					disabled={isLoading}
					className={styles.input}
				/>
			</div>

			<div className={styles.formGroup}>
				<label htmlFor={commentId}>Description (Optional)</label>
				<CommentPresets onSelect={handlePresetSelect} />
				<textarea
					id={commentId}
					value={comment}
					onChange={(e) => setComment(e.target.value)}
					placeholder="Add a description of the work done..."
					rows={4}
					disabled={isLoading}
					className={styles.textarea}
				/>
			</div>

			{error && (
				<div className={styles.error} role="alert">
					{error}
				</div>
			)}

			<div className={styles.actions}>
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
