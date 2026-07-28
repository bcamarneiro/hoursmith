import { describe, expect, it } from 'vitest';
import type {
	DaySummary,
	WorklogSuggestion,
} from '../../../../types/Suggestion';
import { generateMemoryJogQuestions } from '../memoryJogger';

function makeSuggestion(
	overrides: Partial<WorklogSuggestion>,
): WorklogSuggestion {
	return {
		id: 'test-id',
		source: 'jira-activity',
		issueKey: 'TEST-1',
		date: '2024-01-15',
		suggestedTimeSpent: '1h',
		suggestedSeconds: 3600,
		confidence: 'medium',
		reason: 'test',
		logged: false,
		...overrides,
	};
}

function makeDay(overrides: Partial<DaySummary>): DaySummary {
	return {
		date: '2024-01-15',
		dayOfWeek: 1,
		isWeekend: false,
		loggedSeconds: 0,
		targetSeconds: 28800,
		gapSeconds: 28800,
		suggestions: [],
		loggedWorklogs: [],
		...overrides,
	};
}

describe('generateMemoryJogQuestions', () => {
	it('returns no questions on weekends', () => {
		const day = makeDay({ isWeekend: true, gapSeconds: 28800 });
		expect(generateMemoryJogQuestions(day)).toEqual([]);
	});

	it('returns no questions when gap is zero', () => {
		const day = makeDay({ gapSeconds: 0 });
		expect(generateMemoryJogQuestions(day)).toEqual([]);
	});

	it('returns no questions when gap is negative', () => {
		const day = makeDay({ gapSeconds: -3600 });
		expect(generateMemoryJogQuestions(day)).toEqual([]);
	});

	it('generates gap-based question when there is unaccounted time', () => {
		const day = makeDay({ gapSeconds: 7200 });
		const questions = generateMemoryJogQuestions(day);
		expect(questions).toHaveLength(1);
		expect(questions[0].question).toContain('2h unaccounted for');
	});

	it('formats durations correctly in gap question', () => {
		expect(
			generateMemoryJogQuestions(makeDay({ gapSeconds: 1800 }))[0].question,
		).toContain('30m');
		expect(
			generateMemoryJogQuestions(makeDay({ gapSeconds: 5400 }))[0].question,
		).toContain('1h 30m');
		expect(
			generateMemoryJogQuestions(makeDay({ gapSeconds: 28800 }))[0].question,
		).toContain('8h');
	});

	it('generates calendar-based question when unlogged calendar suggestions exist', () => {
		const day = makeDay({
			gapSeconds: 7200,
			suggestions: [
				makeSuggestion({
					source: 'calendar',
					issueKey: 'CAL-1',
					calendarEventTitle: 'Design Review',
					logged: false,
				}),
			],
		});
		const questions = generateMemoryJogQuestions(day);
		expect(questions.length).toBeGreaterThanOrEqual(2);
		const calendarQ = questions.find((q) =>
			q.question.includes('calendar events'),
		);
		expect(calendarQ).toBeDefined();
		expect(calendarQ?.hint).toContain('Design Review');
	});

	it('ignores logged calendar suggestions', () => {
		const day = makeDay({
			gapSeconds: 7200,
			suggestions: [
				makeSuggestion({
					source: 'calendar',
					issueKey: 'CAL-1',
					calendarEventTitle: 'Design Review',
					logged: true,
				}),
			],
		});
		const questions = generateMemoryJogQuestions(day);
		const calendarQ = questions.find((q) =>
			q.question.includes('calendar events'),
		);
		expect(calendarQ).toBeUndefined();
	});

	it('generates git-based question when unlogged gitlab suggestions exist', () => {
		const day = makeDay({
			gapSeconds: 7200,
			suggestions: [
				makeSuggestion({
					source: 'gitlab',
					issueKey: 'GIT-1',
					issueSummary: 'Fix login bug',
					logged: false,
				}),
			],
		});
		const questions = generateMemoryJogQuestions(day);
		const gitQ = questions.find((q) => q.question.includes('commits'));
		expect(gitQ).toBeDefined();
		expect(gitQ?.hint).toContain('Fix login bug');
	});

	it('generates jira-activity question when unlogged jira suggestions exist', () => {
		const day = makeDay({
			gapSeconds: 7200,
			suggestions: [
				makeSuggestion({
					source: 'jira-activity',
					issueKey: 'PROJ-201',
					logged: false,
				}),
			],
		});
		const questions = generateMemoryJogQuestions(day);
		const jiraQ = questions.find((q) =>
			q.question.includes('touched these issues'),
		);
		expect(jiraQ).toBeDefined();
		expect(jiraQ?.hint).toContain('PROJ-201');
	});

	it('limits calendar event list to 3 items', () => {
		const day = makeDay({
			gapSeconds: 7200,
			suggestions: [
				makeSuggestion({
					source: 'calendar',
					calendarEventTitle: 'Event 1',
					logged: false,
				}),
				makeSuggestion({
					source: 'calendar',
					calendarEventTitle: 'Event 2',
					logged: false,
				}),
				makeSuggestion({
					source: 'calendar',
					calendarEventTitle: 'Event 3',
					logged: false,
				}),
				makeSuggestion({
					source: 'calendar',
					calendarEventTitle: 'Event 4',
					logged: false,
				}),
			],
		});
		const questions = generateMemoryJogQuestions(day);
		const calendarQ = questions.find((q) =>
			q.question.includes('calendar events'),
		);
		expect(calendarQ?.hint).toContain('Event 1');
		expect(calendarQ?.hint).toContain('Event 2');
		expect(calendarQ?.hint).toContain('Event 3');
		expect(calendarQ?.hint).not.toContain('Event 4');
	});

	it('generates multiple questions when multiple signal types exist', () => {
		const day = makeDay({
			gapSeconds: 14400,
			suggestions: [
				makeSuggestion({
					source: 'calendar',
					calendarEventTitle: 'Meeting',
					logged: false,
				}),
				makeSuggestion({
					source: 'gitlab',
					issueSummary: 'Commit work',
					logged: false,
				}),
				makeSuggestion({
					source: 'jira-activity',
					issueKey: 'PROJ-1',
					logged: false,
				}),
			],
		});
		const questions = generateMemoryJogQuestions(day);
		expect(questions.length).toBe(4); // gap + calendar + git + jira
	});

	it('falls back to issueKey when issueSummary is missing', () => {
		const day = makeDay({
			gapSeconds: 7200,
			suggestions: [
				makeSuggestion({
					source: 'gitlab',
					issueKey: 'GIT-1',
					issueSummary: undefined,
					logged: false,
				}),
			],
		});
		const questions = generateMemoryJogQuestions(day);
		const gitQ = questions.find((q) => q.question.includes('commits'));
		expect(gitQ?.hint).toContain('GIT-1');
	});
});
