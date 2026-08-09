import type { DaySummary } from '../../../types/Suggestion';
import type { WeekWorklogEntry } from '../../stores/useDashboardStore';
import { formatHours } from './format';

export type WeeklyCloseStatus = 'ready' | 'warning' | 'pending';
export type WeeklyCloseAction =
	| 'jump-gap-days'
	| 'copy-prev-week'
	| 'copy-summary'
	| 'enable-reminders';

export interface WeeklyCloseAssistantItem {
	id: 'gaps' | 'empty-days' | 'suggestions' | 'handoff' | 'reminders';
	title: string;
	status: WeeklyCloseStatus;
	detail: string;
	actionId?: WeeklyCloseAction;
	actionLabel?: string;
}

export interface WeeklyCloseAssistantModel {
	status: WeeklyCloseStatus;
	headline: string;
	detail: string;
	gapHours: number;
	progress: {
		completed: number;
		total: number;
		percent: number;
	};
	items: WeeklyCloseAssistantItem[];
}

type BuildWeeklyCloseAssistantInput = {
	days: DaySummary[];
	weekWorklogs: WeekWorklogEntry[];
	canRemind: boolean;
	reminderEnabled: boolean;
	totalGapHours: number;
};

function formatCount(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function buildWeeklyCloseAssistantModel({
	days,
	weekWorklogs,
	canRemind,
	reminderEnabled,
	totalGapHours,
}: BuildWeeklyCloseAssistantInput): WeeklyCloseAssistantModel {
	const weekdays = days.filter((day) => !day.isWeekend);
	const daysWithGaps = weekdays.filter((day) => day.gapSeconds > 0);
	const emptyDays = weekdays.filter(
		(day) => day.targetSeconds > 0 && day.loggedSeconds === 0,
	);
	const activeSuggestions = daysWithGaps.flatMap((day) =>
		day.suggestions.filter(
			(suggestion) => !suggestion.logged && !!suggestion.issueKey,
		),
	);
	const unmappedSuggestions = daysWithGaps.flatMap((day) =>
		day.suggestions.filter(
			(suggestion) =>
				!suggestion.logged &&
				!suggestion.issueKey &&
				!!suggestion.calendarEventTitle,
		),
	);

	const items: WeeklyCloseAssistantItem[] = [
		{
			id: 'gaps',
			title: 'Fill the remaining gap',
			status: totalGapHours > 0 ? 'warning' : 'ready',
			detail:
				totalGapHours > 0
					? `${formatHours(totalGapHours * 3600)} still missing across ${formatCount(daysWithGaps.length, 'weekday', 'weekdays')}.`
					: 'No remaining weekly gap. The core close-the-week job is done.',
			actionId: daysWithGaps.length > 0 ? 'jump-gap-days' : undefined,
			actionLabel: daysWithGaps.length > 0 ? 'Open gap days' : undefined,
		},
		{
			id: 'empty-days',
			title: 'Review fully empty weekdays',
			status: emptyDays.length > 0 ? 'warning' : 'ready',
			detail:
				emptyDays.length > 0
					? `${formatCount(emptyDays.length, 'weekday has', 'weekdays have')} zero logged hours, so those are usually the fastest places to sanity-check first.`
					: 'Every weekday has at least some logged time recorded.',
			actionId: emptyDays.length > 0 ? 'jump-gap-days' : undefined,
			actionLabel: emptyDays.length > 0 ? 'Review empty days' : undefined,
		},
		{
			id: 'suggestions',
			title: 'Use the suggestion backlog',
			status:
				totalGapHours <= 0
					? 'ready'
					: activeSuggestions.length > 0
						? 'ready'
						: 'warning',
			detail:
				totalGapHours <= 0
					? 'No open gap means suggestion triage is optional now.'
					: activeSuggestions.length > 0
						? `${formatCount(activeSuggestions.length, 'suggestion is', 'suggestions are')} ready to log across the open gap days.`
						: unmappedSuggestions.length > 0
							? `${formatCount(unmappedSuggestions.length, 'calendar item still needs', 'calendar items still need')} mapping before they can help with the gap.`
							: 'There are no ready suggestions right now, so copying the previous week or logging manually may be faster.',
			actionId:
				totalGapHours <= 0
					? undefined
					: activeSuggestions.length > 0 || unmappedSuggestions.length > 0
						? 'jump-gap-days'
						: 'copy-prev-week',
			actionLabel:
				totalGapHours <= 0
					? undefined
					: activeSuggestions.length > 0 || unmappedSuggestions.length > 0
						? 'Review suggestions'
						: 'Copy previous week',
		},
		{
			id: 'handoff',
			title: 'Leave a weekly handoff trail',
			status: weekWorklogs.length > 0 ? 'ready' : 'pending',
			detail:
				weekWorklogs.length > 0
					? 'Copy the Markdown summary or export CSV once you are happy with the week.'
					: 'Exports become useful after the first worklog lands in the current week.',
			actionId: weekWorklogs.length > 0 ? 'copy-summary' : undefined,
			actionLabel: weekWorklogs.length > 0 ? 'Copy summary' : undefined,
		},
		{
			id: 'reminders',
			title: 'Keep the safety net on',
			status: !canRemind
				? 'pending'
				: reminderEnabled
					? 'ready'
					: totalGapHours > 0
						? 'warning'
						: 'pending',
			detail: !canRemind
				? 'Browser notifications are not available here, so reminders stay manual.'
				: reminderEnabled
					? 'Timesheet reminders are enabled for weeks that still have a gap.'
					: totalGapHours > 0
						? 'Reminders are off even though this week still has a gap.'
						: 'No reminder is needed right now because the week is already in good shape.',
			actionId:
				canRemind && !reminderEnabled && totalGapHours > 0
					? 'enable-reminders'
					: undefined,
			actionLabel:
				canRemind && !reminderEnabled && totalGapHours > 0
					? 'Enable reminders'
					: undefined,
		},
	];

	const completed = items.filter((item) => item.status === 'ready').length;
	const total = items.length;
	const weekHasData = weekdays.length > 0;
	const overallStatus: WeeklyCloseStatus = !weekHasData
		? 'pending'
		: totalGapHours > 0 || emptyDays.length > 0
			? 'warning'
			: 'ready';

	const headline = !weekHasData
		? 'Weekly close assistant will wake up when the week has data'
		: overallStatus === 'ready'
			? 'You are clear to close the week'
			: 'Here is what still deserves attention before the week feels done';

	const detail = !weekHasData
		? 'Once Jira worklogs land for this week, the assistant will summarise the fastest next actions.'
		: overallStatus === 'ready'
			? 'The week is in good shape. What remains is mostly about sharing or exporting the result, not chasing missing hours.'
			: 'The assistant is pointing at the smallest number of actions that should move the week from “probably fine” to “trustworthy and done.”';

	return {
		status: overallStatus,
		headline,
		detail,
		gapHours: totalGapHours,
		progress: {
			completed,
			total,
			percent: Math.round((completed / total) * 100),
		},
		items,
	};
}
