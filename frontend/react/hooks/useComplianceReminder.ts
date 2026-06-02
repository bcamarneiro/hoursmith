import { useCallback, useEffect, useMemo, useState } from 'react';
import { migrateStorageKey } from '../../stores/migrateStorageKeys';
import { useConfigStore } from '../../stores/useConfigStore';
import { useDashboardStore } from '../../stores/useDashboardStore';
import { toLocalDateString } from '../utils/date';

const STORAGE_KEY = 'hoursmith-last-reminded-week';

// Carry existing users' data across the jira-timesheet-report → hoursmith rename.
migrateStorageKey('jira-timesheet-last-reminded-week', STORAGE_KEY);

interface ComplianceReminderResult {
	canRemind: boolean;
	reminderEnabled: boolean;
	enableReminder: () => void;
	totalGapHours: number;
}

function getWeekKey(weekStart: string): string {
	return `reminded-${weekStart}`;
}

function wasRemindedThisWeek(weekStart: string): boolean {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		return stored === getWeekKey(weekStart);
	} catch {
		return false;
	}
}

function markRemindedThisWeek(weekStart: string): void {
	try {
		localStorage.setItem(STORAGE_KEY, getWeekKey(weekStart));
	} catch {
		// localStorage may be unavailable
	}
}

export function useComplianceReminder(): ComplianceReminderResult {
	const daySummaries = useDashboardStore((s) => s.daySummaries);
	const weekStart = useDashboardStore((s) => s.weekStart);
	const reminderEnabled = useConfigStore(
		(s) => s.config.complianceReminderEnabled,
	);
	const setConfig = useConfigStore((s) => s.setConfig);
	const config = useConfigStore((s) => s.config);

	const [canRemind] = useState(() => typeof Notification !== 'undefined');

	const weekdays = useMemo(
		() => daySummaries.filter((d) => !d.isWeekend),
		[daySummaries],
	);

	const totalGapHours = useMemo(() => {
		const totalGapSeconds = weekdays.reduce((sum, d) => sum + d.gapSeconds, 0);
		return totalGapSeconds / 3600;
	}, [weekdays]);

	const hasGaps = totalGapHours > 0;

	const enableReminder = useCallback(() => {
		if (!canRemind) return;

		Notification.requestPermission().then((permission) => {
			if (permission === 'granted') {
				setConfig({ ...config, complianceReminderEnabled: true });
			}
		});
	}, [canRemind, config, setConfig]);

	// Send notification if conditions are met
	useEffect(() => {
		if (!reminderEnabled || !hasGaps || !canRemind) return;
		if (wasRemindedThisWeek(weekStart)) return;

		const now = new Date();
		const currentHour = now.getHours();

		// Only remind after 14:00
		if (currentHour < 14) return;

		// Find the last weekday with a gap
		const daysWithGaps = weekdays.filter((d) => d.gapSeconds > 0);
		if (daysWithGaps.length === 0) return;

		const lastGapDay = daysWithGaps[daysWithGaps.length - 1];
		const today = toLocalDateString(now);
		const isFriday = now.getDay() === 5;

		// Show notification if today is the last gap day or it's Friday
		if (today === lastGapDay.date || isFriday) {
			if (Notification.permission === 'granted') {
				new Notification('Timesheet Reminder', {
					body: `You have ${totalGapHours.toFixed(1)} hours to fill this week.`,
					icon: '/favicon.ico',
				});
				markRemindedThisWeek(weekStart);
			}
		}
	}, [reminderEnabled, hasGaps, canRemind, weekStart, weekdays, totalGapHours]);

	return { canRemind, reminderEnabled, enableReminder, totalGapHours };
}
