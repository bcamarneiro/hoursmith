import type { JiraWorklog } from '../../../types/JiraWorklog';
import { classifyWorklog } from './worklogClassifier';

export type GroupedWorklogs = Record<string, Record<string, JiraWorklog[]>>;

export function groupWorklogsByUserAndDate(
	worklogs: JiraWorklog[] | null,
): GroupedWorklogs {
	const map: GroupedWorklogs = {};
	(worklogs || []).forEach((wl) => {
		const user = wl.author?.displayName;
		// Drop worklogs that are missing the author or started date — defensive
		// against malformed Jira responses; production hits this path with
		// well-formed data.
		if (!user || !wl.started) return;
		const date = wl.classified?.loggedOn ?? classifyWorklog(wl).loggedOn;
		if (!date) return;
		if (!map[user]) map[user] = {};
		if (!map[user][date]) map[user][date] = [];
		map[user][date].push(wl);
	});
	return map;
}
