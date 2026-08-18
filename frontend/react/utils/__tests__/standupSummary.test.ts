import { describe, expect, it } from 'vitest';
import {
	generateStandupSummary,
	getStandupDateRange,
} from '../standupSummary';

describe('getStandupDateRange', () => {
	it('returns yesterday for Tuesday', () => {
		// 2026-03-10 is a Tuesday
		const tuesday = new Date(2026, 2, 10);
		const range = getStandupDateRange(tuesday);
		expect(range.start).toBe('2026-03-09');
		expect(range.end).toBe('2026-03-09');
		expect(range.label).toBe('Mon');
	});

	it('returns yesterday for Wednesday', () => {
		// 2026-03-11 is a Wednesday
		const wednesday = new Date(2026, 2, 11);
		const range = getStandupDateRange(wednesday);
		expect(range.start).toBe('2026-03-10');
		expect(range.end).toBe('2026-03-10');
		expect(range.label).toBe('Tue');
	});

	it('returns yesterday for Friday', () => {
		// 2026-03-13 is a Friday
		const friday = new Date(2026, 2, 13);
		const range = getStandupDateRange(friday);
		expect(range.start).toBe('2026-03-12');
		expect(range.end).toBe('2026-03-12');
		expect(range.label).toBe('Thu');
	});

	it('returns Friday–Sunday for Monday', () => {
		// 2026-03-09 is a Monday
		const monday = new Date(2026, 2, 9);
		const range = getStandupDateRange(monday);
		expect(range.start).toBe('2026-03-06'); // Friday
		expect(range.end).toBe('2026-03-08'); // Sunday
		expect(range.label).toBe('Friday – Sunday');
	});

	it('returns Friday for Saturday', () => {
		// 2026-03-14 is a Saturday
		const saturday = new Date(2026, 2, 14);
		const range = getStandupDateRange(saturday);
		expect(range.start).toBe('2026-03-13');
		expect(range.end).toBe('2026-03-13');
		expect(range.label).toBe('Friday');
	});

	it('returns Friday for Sunday', () => {
		// 2026-03-15 is a Sunday
		const sunday = new Date(2026, 2, 15);
		const range = getStandupDateRange(sunday);
		expect(range.start).toBe('2026-03-13');
		expect(range.end).toBe('2026-03-13');
		expect(range.label).toBe('Friday');
	});
});

describe('generateStandupSummary', () => {
	it('returns a no-worklogs message when none match the range', () => {
		const result = generateStandupSummary(
			[{ date: '2026-03-10', issueKey: 'X-1', timeSpentSeconds: 3600 }],
			'2026-03-11',
			'2026-03-11',
		);
		expect(result).toBe('No worklogs recorded.');
	});

	it('returns a no-worklogs message for empty input', () => {
		const result = generateStandupSummary([], '2026-03-09', '2026-03-11');
		expect(result).toBe('No worklogs recorded.');
	});

	it('formats a single issue correctly', () => {
		const result = generateStandupSummary(
			[
				{
					date: '2026-03-09',
					issueKey: 'PROJ-123',
					issueSummary: 'Implement login',
					timeSpentSeconds: 7200,
				},
			],
			'2026-03-09',
			'2026-03-09',
		);
		expect(result).toContain('PROJ-123 - Implement login (2h)');
		expect(result).toContain('Total: 2h');
	});

	it('groups multiple worklogs for the same issue', () => {
		const result = generateStandupSummary(
			[
				{
					date: '2026-03-09',
					issueKey: 'PROJ-123',
					issueSummary: 'Implement login',
					timeSpentSeconds: 3600,
				},
				{
					date: '2026-03-09',
					issueKey: 'PROJ-123',
					issueSummary: 'Implement login',
					timeSpentSeconds: 3600,
				},
			],
			'2026-03-09',
			'2026-03-09',
		);
		expect(result).toContain('PROJ-123 - Implement login (2h)');
		expect(result).toContain('Total: 2h');
	});

	it('handles multiple issues sorted by time descending', () => {
		const result = generateStandupSummary(
			[
				{
					date: '2026-03-09',
					issueKey: 'PROJ-LOW',
					issueSummary: 'Minor fix',
					timeSpentSeconds: 1800,
				},
				{
					date: '2026-03-09',
					issueKey: 'PROJ-HIGH',
					issueSummary: 'Big feature',
					timeSpentSeconds: 7200,
				},
			],
			'2026-03-09',
			'2026-03-09',
		);
		expect(result.indexOf('PROJ-HIGH')).toBeLessThan(
			result.indexOf('PROJ-LOW'),
		);
		expect(result).toContain('Total: 2h 30m');
	});

	it('handles issues without a summary', () => {
		const result = generateStandupSummary(
			[
				{
					date: '2026-03-09',
					issueKey: 'PROJ-999',
					timeSpentSeconds: 1800,
				},
			],
			'2026-03-09',
			'2026-03-09',
		);
		expect(result).toContain('PROJ-999 (30m)');
	});

	it('filters worklogs outside the date range', () => {
		const result = generateStandupSummary(
			[
				{
					date: '2026-03-08',
					issueKey: 'OLD-1',
					timeSpentSeconds: 7200,
				},
				{
					date: '2026-03-09',
					issueKey: 'NEW-1',
					issueSummary: 'Today work',
					timeSpentSeconds: 3600,
				},
				{
					date: '2026-03-10',
					issueKey: 'FUTURE-1',
					timeSpentSeconds: 7200,
				},
			],
			'2026-03-09',
			'2026-03-09',
		);
		expect(result).toContain('NEW-1');
		expect(result).not.toContain('OLD-1');
		expect(result).not.toContain('FUTURE-1');
	});

	it('handles a multi-day range (Friday–Sunday)', () => {
		const result = generateStandupSummary(
			[
				{
					date: '2026-03-06',
					issueKey: 'PROJ-1',
					issueSummary: 'Friday work',
					timeSpentSeconds: 3600,
				},
				{
					date: '2026-03-07',
					issueKey: 'PROJ-1',
					issueSummary: 'Saturday work',
					timeSpentSeconds: 1800,
				},
				{
					date: '2026-03-08',
					issueKey: 'PROJ-2',
					issueSummary: 'Sunday work',
					timeSpentSeconds: 5400,
				},
			],
			'2026-03-06',
			'2026-03-08',
		);
		expect(result).toContain('PROJ-1');
		expect(result).toContain('PROJ-2');
		expect(result).toContain('Total: 3h');
	});

	it('formats minutes-only durations correctly', () => {
		const result = generateStandupSummary(
			[
				{
					date: '2026-03-09',
					issueKey: 'PROJ-1',
					timeSpentSeconds: 900, // 15m
				},
			],
			'2026-03-09',
			'2026-03-09',
		);
		expect(result).toContain('PROJ-1 (15m)');
		expect(result).toContain('Total: 15m');
	});
});
