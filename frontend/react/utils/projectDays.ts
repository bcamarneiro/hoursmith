import type { EnrichedJiraWorklog } from '../../../types/jira';
import { type ClassifiedWorklog, classifyWorklog } from './worklogClassifier';

export interface GhostEntry {
	worklog: EnrichedJiraWorklog;
	classified: ClassifiedWorklog;
}

export interface ProjectedDays {
	loggedDays: Record<string, EnrichedJiraWorklog[]>;
	ghostsByDay: Record<string, GhostEntry[]>;
	backdatedIds: Set<string>;
	classifications: Map<string, ClassifiedWorklog>;
}

/**
 * Re-bucket grouped worklogs (currently keyed by `started`) into:
 * - loggedDays: each worklog placed under its `loggedOn` date (drives totals)
 * - ghostsByDay: a non-counting reference under `intendedFor` for backdated entries
 * - backdatedIds: ids of worklogs flagged as backdated
 *
 * For non-backdated entries `loggedOn === intendedFor`, so no ghost is emitted.
 */
export function projectDays(
	days: Record<string, EnrichedJiraWorklog[]>,
): ProjectedDays {
	const loggedDays: Record<string, EnrichedJiraWorklog[]> = {};
	const ghostsByDay: Record<string, GhostEntry[]> = {};
	const backdatedIds = new Set<string>();
	const classifications = new Map<string, ClassifiedWorklog>();

	for (const list of Object.values(days)) {
		for (const wl of list) {
			const c = wl.classified ?? classifyWorklog(wl);
			const key = wl.id ?? '';
			if (key) classifications.set(key, c);

			const loggedKey = c.loggedOn;
			if (loggedKey) {
				if (!loggedDays[loggedKey]) loggedDays[loggedKey] = [];
				loggedDays[loggedKey].push(wl);
			}

			if (c.isBackdated) {
				if (key) backdatedIds.add(key);
				if (c.intendedFor && c.intendedFor !== c.loggedOn) {
					if (!ghostsByDay[c.intendedFor]) ghostsByDay[c.intendedFor] = [];
					ghostsByDay[c.intendedFor].push({ worklog: wl, classified: c });
				}
			}
		}
	}

	return { loggedDays, ghostsByDay, backdatedIds, classifications };
}
