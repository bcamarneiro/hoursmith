import { useEffect, useMemo, useRef, useState } from 'react';
import type { DaySummary } from '../../../types/Suggestion';
import {
	computeCurrentDayStreak,
	computeCurrentWeekStreak,
	toWeekdayMetInfo,
	type StreakDayInput,
} from '../utils/streaks';
import { migrateStorageKey } from '../stores/migrateStorageKeys';

/**
 * localStorage keys for streak persistence.
 * Follows the same prefix pattern as useComplianceReminder.
 */
const STORAGE_KEY_BEST_DAY = 'hoursmith-streak-best-day';
const STORAGE_KEY_BEST_WEEK = 'hoursmith-streak-best-week';
const STORAGE_KEY_DAY_LOG = 'hoursmith-streak-day-log';

// Carry existing users' data across the jira-timesheet → hoursmith rename.
migrateStorageKey('jira-timesheet-best-streaks', STORAGE_KEY_BEST_DAY);
migrateStorageKey('jira-timesheet-best-streaks', STORAGE_KEY_BEST_WEEK);

/** A persisted record of a weekday's met-status. */
interface DayLogEntry {
	date: string;
	met: boolean;
}

/**
 * Read the persisted day log from localStorage.
 * Returns an empty array if nothing is stored or on parse error.
 */
function readDayLog(): DayLogEntry[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY_DAY_LOG);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(e: unknown): e is DayLogEntry =>
				typeof e === 'object' &&
				e !== null &&
				typeof (e as DayLogEntry).date === 'string' &&
				typeof (e as DayLogEntry).met === 'boolean',
		);
	} catch {
		return [];
	}
}

/**
 * Write the day log to localStorage.
 */
function writeDayLog(log: DayLogEntry[]): void {
	try {
		localStorage.setItem(STORAGE_KEY_DAY_LOG, JSON.stringify(log));
	} catch {
		// localStorage full or unavailable — silently ignore
	}
}

/**
 * Read a number from localStorage, returning 0 if missing or invalid.
 */
function readBest(key: string): number {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return 0;
		const n = parseInt(raw, 10);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}

/**
 * Write a number to localStorage.
 */
function writeBest(key: string, value: number): void {
	try {
		localStorage.setItem(key, String(value));
	} catch {
		// silently ignore
	}
}

/**
 * Merge current week's weekday data into the persisted day log.
 * Updates existing entries and adds new ones.
 */
function mergeDayLog(
	existing: DayLogEntry[],
	newEntries: DayLogEntry[],
): DayLogEntry[] {
	const map = new Map(existing.map((e) => [e.date, e]));
	for (const entry of newEntries) {
		map.set(entry.date, entry);
	}
	// Keep only the last 90 days to avoid unbounded growth
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - 90);
	const cutoffISO = cutoff.toISOString().slice(0, 10);
	return [...map.values()]
		.filter((e) => e.date >= cutoffISO)
		.sort((a, b) => a.date.localeCompare(b.date));
}

export interface StreakState {
	/** Current consecutive weekday streak ending at today. */
	dayStreak: number;
	/** Best day streak ever recorded (persisted). */
	bestDayStreak: number;
	/** Current consecutive full-week streak. */
	weekStreak: number;
	/** Best week streak ever recorded (persisted). */
	bestWeekStreak: number;
}

/**
 * Hook that computes on-time logging streaks from day summaries.
 *
 * Persists best streaks and a rolling day-log in localStorage so streaks
 * survive across weeks and page reloads. Updates best streaks whenever
 * the current streak exceeds the previous best.
 *
 * @param daySummaries - The current week's DaySummary[] from the store
 * @returns Current and best streaks for days and weeks
 */
export function useStreaks(daySummaries: DaySummary[]): StreakState {
	const today = useMemo(() => {
		const d = new Date();
		return d.toISOString().slice(0, 10);
	}, []);

	// Convert current week's summaries to streak input
	const currentWeekdays = useMemo(() => {
		const input: StreakDayInput[] = daySummaries.map((s) => ({
			date: s.date,
			isWeekend: s.isWeekend,
			loggedSeconds: s.loggedSeconds,
			targetSeconds: s.targetSeconds,
		}));
		return toWeekdayMetInfo(input);
	}, [daySummaries]);

	// Merge current week data into persisted log
	const dayLog = useMemo(() => {
		const existing = readDayLog();
		const merged = mergeDayLog(existing, currentWeekdays);
		return merged;
	}, [currentWeekdays]);

	// Persist the merged log
	const prevLogRef = useRef<string>('');
	useEffect(() => {
		const serialized = JSON.stringify(dayLog);
		if (serialized !== prevLogRef.current) {
			prevLogRef.current = serialized;
			writeDayLog(dayLog);
		}
	}, [dayLog]);

	// Compute current streaks from the full log
	const dayStreak = useMemo(
		() => computeCurrentDayStreak(dayLog, today),
		[dayLog, today],
	);

	const weekStreak = useMemo(
		() => computeCurrentWeekStreak(dayLog, today),
		[dayLog, today],
	);

	// Best streaks - read initial values, update via useEffect
	const [bestDayStreak, setBestDayStreak] = useState(() => readBest(STORAGE_KEY_BEST_DAY));
	const [bestWeekStreak, setBestWeekStreak] = useState(() => readBest(STORAGE_KEY_BEST_WEEK));

	// Persist best streaks when current streaks exceed them
	useEffect(() => {
		if (dayStreak > bestDayStreak) {
			writeBest(STORAGE_KEY_BEST_DAY, dayStreak);
			setBestDayStreak(dayStreak);
		}
		if (weekStreak > bestWeekStreak) {
			writeBest(STORAGE_KEY_BEST_WEEK, weekStreak);
			setBestWeekStreak(weekStreak);
		}
	}, [dayStreak, weekStreak, bestDayStreak, bestWeekStreak]);

	return { dayStreak, bestDayStreak, weekStreak, bestWeekStreak };
}
