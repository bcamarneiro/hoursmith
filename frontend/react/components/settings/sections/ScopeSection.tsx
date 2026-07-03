import type React from 'react';
import { SETTINGS_SECTION_IDS } from '../../../constants/settingsSections';
import { AllowedUsersInput } from '../AllowedUsersInput';
import * as styles from '../SettingsForm.module.css';

type Props = {
	jqlFilter: string;
	allowedUsers: string;
	allowedUserSuggestions: string[];
	handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onAllowedUsersChange: (next: string) => void;
	jqlFilterId: string;
	allowedUsersId: string;
	expectedDailyHours: number;
	expectedHoursByUser: Record<string, number>;
	onExpectedDailyHoursChange: (hours: number) => void;
	onExpectedHoursOverrideChange: (email: string, hours: number | null) => void;
	expectedDailyHoursId: string;
	weeklyDeadlineWeekday: number;
	weeklyDeadlineTime: string;
	onWeeklyDeadlineWeekdayChange: (weekday: number) => void;
	onWeeklyDeadlineTimeChange: (time: string) => void;
	weeklyDeadlineWeekdayId: string;
	weeklyDeadlineTimeId: string;
};

const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
	{ value: 1, label: 'Monday' },
	{ value: 2, label: 'Tuesday' },
	{ value: 3, label: 'Wednesday' },
	{ value: 4, label: 'Thursday' },
	{ value: 5, label: 'Friday' },
	{ value: 6, label: 'Saturday' },
	{ value: 7, label: 'Sunday' },
];

/** Parse a number input into a per-day hours value, or null when the field is
 *  cleared / invalid (so a per-user override reverts to the team default). */
function parseHoursInput(raw: string): number | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const value = Number.parseFloat(trimmed);
	if (!Number.isFinite(value) || value <= 0) return null;
	return Math.min(value, 24);
}

function splitAllowedUsers(allowedUsers: string): string[] {
	return Array.from(
		new Set(
			allowedUsers
				.split(',')
				.map((email) => email.trim().toLowerCase())
				.filter(Boolean),
		),
	);
}

/**
 * Reports Scope section: JQL filter + allowed-users chip editor + working-hours
 * expectations (ADA-392). `onAllowedUsersChange` is split out from
 * `handleChange` because the chip editor doesn't emit native input events; the
 * expected-hours handlers are likewise split because those values are numeric /
 * keyed and don't map cleanly onto the string-based `handleChange`.
 */
export const ScopeSection: React.FC<Props> = ({
	jqlFilter,
	allowedUsers,
	allowedUserSuggestions,
	handleChange,
	onAllowedUsersChange,
	jqlFilterId,
	allowedUsersId,
	expectedDailyHours,
	expectedHoursByUser,
	onExpectedDailyHoursChange,
	onExpectedHoursOverrideChange,
	expectedDailyHoursId,
	weeklyDeadlineWeekday,
	weeklyDeadlineTime,
	onWeeklyDeadlineWeekdayChange,
	onWeeklyDeadlineTimeChange,
	weeklyDeadlineWeekdayId,
	weeklyDeadlineTimeId,
}) => {
	const members = splitAllowedUsers(allowedUsers);
	return (
		<fieldset id={SETTINGS_SECTION_IDS.scope} className={styles.section}>
			<legend className={styles.sectionTitle}>Reports Scope</legend>
			<div className={styles.formGroup}>
				<label htmlFor={jqlFilterId}>
					JQL Filter <span className={styles.optional}>optional</span>
				</label>
				<input
					type="text"
					id={jqlFilterId}
					name="jqlFilter"
					value={jqlFilter}
					onChange={handleChange}
					placeholder="project = MYPROJECT"
				/>
				<small>Applied to all timesheet queries</small>
			</div>
			<div className={styles.formGroup}>
				<label htmlFor={allowedUsersId}>
					Team Members <span className={styles.optional}>optional</span>
				</label>
				<AllowedUsersInput
					id={allowedUsersId}
					value={allowedUsers}
					onChange={onAllowedUsersChange}
					suggestions={allowedUserSuggestions}
					placeholder="john@example.com, jane@example.com"
				/>
				<small>
					Add the teammates you want to keep in scope for Reports and for shared
					time-off assignments. Press <code>Enter</code>, <code>Tab</code>, or
					paste a list to create chips.
				</small>
			</div>
			<div className={styles.formGroup}>
				<label htmlFor={expectedDailyHoursId}>Expected hours per day</label>
				<input
					className={styles.expectedHoursInput}
					type="number"
					inputMode="decimal"
					min="1"
					max="24"
					step="0.5"
					id={expectedDailyHoursId}
					value={expectedDailyHours}
					onChange={(e) => {
						const parsed = parseHoursInput(e.target.value);
						// Empty / invalid falls back to the 8h baseline rather than 0, which
						// would flag no one and is almost always a mis-edit.
						onExpectedDailyHoursChange(parsed ?? 8);
					}}
				/>
				<small>
					The team-wide daily target used to compute completeness and gaps.
					Absences already reduce it per day.
				</small>
			</div>
			{members.length > 0 && (
				<div className={styles.formGroup}>
					<span className={styles.fieldLabel}>
						Per-person overrides{' '}
						<span className={styles.optional}>optional</span>
					</span>
					<div className={styles.expectedHoursRows}>
						{members.map((email) => {
							const override = expectedHoursByUser[email];
							return (
								<label key={email} className={styles.expectedHoursRow}>
									<span title={email}>{email}</span>
									<input
										className={styles.expectedHoursInput}
										type="number"
										inputMode="decimal"
										min="1"
										max="24"
										step="0.5"
										value={override ?? ''}
										placeholder={`${expectedDailyHours}`}
										aria-label={`Expected hours per day for ${email}`}
										onChange={(e) =>
											onExpectedHoursOverrideChange(
												email,
												parseHoursInput(e.target.value),
											)
										}
									/>
								</label>
							);
						})}
					</div>
					<small>
						Set a different daily target for contractors or part-timers (e.g. 6h
						for a 30h week). Leave blank to use the team default above.
					</small>
				</div>
			)}
			<div className={styles.formGroup}>
				<span className={styles.fieldLabel}>Weekly deadline</span>
				<div className={styles.deadlineRow}>
					<select
						id={weeklyDeadlineWeekdayId}
						value={weeklyDeadlineWeekday}
						aria-label="Weekly deadline day"
						onChange={(e) =>
							onWeeklyDeadlineWeekdayChange(Number.parseInt(e.target.value, 10))
						}
					>
						{WEEKDAY_OPTIONS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
					<input
						id={weeklyDeadlineTimeId}
						type="time"
						value={weeklyDeadlineTime}
						aria-label="Weekly deadline time"
						onChange={(e) => onWeeklyDeadlineTimeChange(e.target.value)}
					/>
				</div>
				<small>
					When each week's timesheets are due. Members are marked on-time, late,
					or incomplete against this cutoff in Reports.
				</small>
			</div>
		</fieldset>
	);
};
