import type React from 'react';
import { useState } from 'react';

import type { EnrichedJiraWorklog } from '../../../types/jira';
import type { AbsenceDay } from '../../services/absenceService';
import { useConfigStore } from '../../stores/useConfigStore';
import { useDayCalculation } from '../hooks/useDayCalculation';
import { useWorklogOperations } from '../hooks/useWorklogOperations';
import type { GhostEntry } from '../utils/projectDays';
import * as styles from './DayCell.module.css';
import { DaySummary } from './day/DaySummary';
import { WorklogList } from './day/WorklogList';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Modal } from './ui/Modal';
import { toast } from './ui/Toast';
import { WorklogForm } from './worklog/WorklogForm';

type Props = {
	iso: string;
	dayNumber: number;
	worklogs: EnrichedJiraWorklog[];
	ghosts?: GhostEntry[];
	issueSummaries: Record<string, string>;
	isWeekend: boolean;
	isAbsent?: boolean;
	absenceDay?: AbsenceDay;
	isToday: boolean;
};

export const DayCell: React.FC<Props> = ({
	iso,
	dayNumber,
	worklogs,
	ghosts,
	issueSummaries,
	isWeekend,
	isAbsent = false,
	absenceDay,
	isToday,
}) => {
	const canAdd = useConfigStore((s) => s.config.canAddWorklogs);
	const canEdit = useConfigStore((s) => s.config.canEditWorklogs);
	const canDelete = useConfigStore((s) => s.config.canDeleteWorklogs);

	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [worklogToEdit, setWorklogToEdit] =
		useState<EnrichedJiraWorklog | null>(null);
	const [worklogToDelete, setWorklogToDelete] =
		useState<EnrichedJiraWorklog | null>(null);

	const { createWorklog, updateWorklog, deleteWorklog, isLoading } =
		useWorklogOperations();
	const hasAbsence = isAbsent || !!absenceDay;

	const {
		dayTotalSeconds,
		effectiveSeconds,
		missingSeconds,
		backdatedSeconds,
	} = useDayCalculation(worklogs, isWeekend, hasAbsence, absenceDay?.kind);

	const getDayClass = () => {
		const classes = [styles.dayCell];
		if (isToday) classes.push(styles.today);

		if (isWeekend) {
			classes.push(dayTotalSeconds > 0 ? styles.weekend : styles.weekendEmpty);
		} else if (hasAbsence) {
			classes.push(
				dayTotalSeconds > 0 ? styles.absenceWorked : styles.absenceDay,
			);
		} else {
			if (effectiveSeconds === 8 * 3600) classes.push(styles.weekdayComplete);
			else if (effectiveSeconds < 8 * 3600)
				classes.push(styles.weekdayIncomplete);
			else classes.push(styles.weekdayOvertime);
		}
		return classes.join(' ');
	};

	const handleCreateWorklog = async (data: {
		issueKey: string;
		timeSpent: string;
		comment: string;
		started: string;
	}) => {
		await createWorklog(data);
		setIsCreateModalOpen(false);
		toast.success('Worklog created');
	};

	const handleEditWorklog = (worklog: EnrichedJiraWorklog) => {
		setWorklogToEdit(worklog);
		setIsEditModalOpen(true);
	};

	const handleUpdateWorklog = async (data: {
		issueKey: string;
		timeSpent: string;
		comment: string;
		started: string;
	}) => {
		if (!worklogToEdit || !worklogToEdit.id || !worklogToEdit.issue?.key)
			return;

		await updateWorklog(worklogToEdit.issue.key, worklogToEdit.id, {
			timeSpent: data.timeSpent,
			comment: data.comment,
			started: data.started,
		});

		setIsEditModalOpen(false);
		setWorklogToEdit(null);
		toast.success('Worklog updated');
	};

	const handleConfirmDelete = async () => {
		if (!worklogToDelete?.id || !worklogToDelete?.issue?.key) return;
		await deleteWorklog(worklogToDelete.issue.key, worklogToDelete.id);
		setWorklogToDelete(null);
		toast.success('Worklog deleted');
	};

	const isoToDateTimeLocal = (isoDate: string) => {
		const date = new Date(isoDate);
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hours = String(date.getHours()).padStart(2, '0');
		const minutes = String(date.getMinutes()).padStart(2, '0');
		return `${year}-${month}-${day}T${hours}:${minutes}`;
	};

	const defaultStarted = `${iso}T09:00`;

	return (
		<>
			<div key={iso} className={getDayClass()}>
				<div className={styles.header}>
					<div className={styles.dayNumber}>{String(dayNumber)}</div>
					<div className={styles.headerRight}>
						{worklogs.length > 0 && (
							<div className={styles.logInfo}>
								{worklogs.length} {worklogs.length === 1 ? 'log' : 'logs'}
							</div>
						)}
						{canAdd && (
							<div className={styles.controls}>
								<button
									type="button"
									onClick={() => setIsCreateModalOpen(true)}
									className={styles.addButton}
									title="Add worklog"
								>
									+
								</button>
							</div>
						)}
					</div>
				</div>
				<WorklogList
					worklogs={worklogs}
					ghosts={ghosts}
					issueSummaries={issueSummaries}
					onEdit={canEdit ? handleEditWorklog : undefined}
					onDelete={canDelete ? (wl) => setWorklogToDelete(wl) : undefined}
				/>
				<DaySummary
					dayTotalSeconds={dayTotalSeconds}
					missingSeconds={missingSeconds}
					isWeekend={isWeekend}
					isAbsent={hasAbsence}
					absenceKind={absenceDay?.kind}
					backdatedSeconds={backdatedSeconds}
				/>
			</div>

			{canAdd && (
				<Modal
					isOpen={isCreateModalOpen}
					onClose={() => setIsCreateModalOpen(false)}
					title="Create Worklog"
				>
					<WorklogForm
						initialData={{
							issueKey: '',
							timeSpent: '',
							comment: '',
							started: defaultStarted,
						}}
						onSubmit={handleCreateWorklog}
						onCancel={() => setIsCreateModalOpen(false)}
						isLoading={isLoading}
					/>
				</Modal>
			)}

			{canEdit && (
				<Modal
					isOpen={isEditModalOpen}
					onClose={() => {
						setIsEditModalOpen(false);
						setWorklogToEdit(null);
					}}
					title="Edit Worklog"
				>
					{worklogToEdit && (
						<WorklogForm
							initialData={{
								issueKey: worklogToEdit.issue?.key || '',
								timeSpent: worklogToEdit.timeSpent || '',
								comment:
									typeof worklogToEdit.comment === 'string'
										? worklogToEdit.comment
										: '',
								started: worklogToEdit.started
									? isoToDateTimeLocal(worklogToEdit.started)
									: defaultStarted,
							}}
							onSubmit={handleUpdateWorklog}
							onCancel={() => {
								setIsEditModalOpen(false);
								setWorklogToEdit(null);
							}}
							isEdit
							isLoading={isLoading}
						/>
					)}
				</Modal>
			)}

			{canDelete && (
				<ConfirmDialog
					isOpen={worklogToDelete !== null}
					title="Delete Worklog"
					message={`Are you sure you want to delete this worklog for ${worklogToDelete?.issue?.key ?? 'this issue'}?`}
					confirmLabel="Delete"
					onConfirm={handleConfirmDelete}
					onCancel={() => setWorklogToDelete(null)}
				/>
			)}
		</>
	);
};
