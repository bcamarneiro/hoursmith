import { describe, expect, it } from 'vitest';
import type { DaySummary } from '../../../../types/Suggestion';
import { buildWeeklyCloseAssistantModel } from '../weeklyCloseAssistant';

function createDay(overrides: Partial<DaySummary>): DaySummary {
	return {
		date: '2026-03-23',
		dayOfWeek: 1,
		isWeekend: false,
		loggedSeconds: 8 * 3600,
		targetSeconds: 8 * 3600,
		gapSeconds: 0,
		suggestions: [],
		...overrides,
		loggedWorklogs: [],
	};
}

describe('buildWeeklyCloseAssistantModel', () => {
	it('marks a clean week as ready', () => {
		const model = buildWeeklyCloseAssistantModel({
			days: [
				createDay({ date: '2026-03-23' }),
				createDay({ date: '2026-03-24', dayOfWeek: 2 }),
			],
			weekWorklogs: [
				{
					date: '2026-03-23',
					issueKey: 'APP-1',
					timeSpentSeconds: 3600,
				},
			],
			canRemind: true,
			reminderEnabled: true,
			totalGapHours: 0,
		});

		expect(model.status).toBe('ready');
		expect(model.headline).toBe('You are clear to close the week');
		expect(model.items.find((item) => item.id === 'gaps')?.status).toBe(
			'ready',
		);
		expect(model.items.find((item) => item.id === 'handoff')?.actionId).toBe(
			'copy-summary',
		);
	});

	it('flags open gaps with no reusable suggestions', () => {
		const model = buildWeeklyCloseAssistantModel({
			days: [
				createDay({
					loggedSeconds: 0,
					gapSeconds: 8 * 3600,
					suggestions: [],
				}),
			],
			weekWorklogs: [],
			canRemind: true,
			reminderEnabled: false,
			totalGapHours: 8,
		});

		expect(model.status).toBe('warning');
		expect(
			model.items.find((item) => item.id === 'suggestions')?.actionId,
		).toBe('copy-prev-week');
		expect(model.items.find((item) => item.id === 'reminders')?.status).toBe(
			'warning',
		);
	});

	it('treats ready suggestions as a positive signal during weekly close', () => {
		const model = buildWeeklyCloseAssistantModel({
			days: [
				createDay({
					loggedSeconds: 6 * 3600,
					gapSeconds: 2 * 3600,
					suggestions: [
						{
							id: 's-1',
							source: 'calendar',
							issueKey: 'APP-2',
							issueSummary: 'Meeting follow-up',
							date: '2026-03-23',
							suggestedTimeSpent: '2h',
							suggestedSeconds: 2 * 3600,
							confidence: 'high',
							reason: 'Calendar event matched a Jira issue',
							logged: false,
						},
					],
				}),
			],
			weekWorklogs: [
				{
					date: '2026-03-23',
					issueKey: 'APP-2',
					timeSpentSeconds: 6 * 3600,
				},
			],
			canRemind: false,
			reminderEnabled: false,
			totalGapHours: 2,
		});

		expect(model.items.find((item) => item.id === 'suggestions')?.status).toBe(
			'ready',
		);
		expect(
			model.items.find((item) => item.id === 'suggestions')?.actionId,
		).toBe('jump-gap-days');
	});
});
