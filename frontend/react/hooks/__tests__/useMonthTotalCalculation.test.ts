import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JiraWorklog } from '../../../../types/JiraWorklog';
import { useMonthTotalCalculation } from '../useMonthTotalCalculation';

describe('useMonthTotalCalculation', () => {
	const createMockWorklog = (
		timeSpentSeconds: number,
		started: string,
	): JiraWorklog => ({
		id: Math.random().toString(),
		self: 'http://jira.com/worklog/1',
		author: {
			self: 'http://jira.com/user/1',
			accountId: 'acc123',
			displayName: 'John Doe',
			active: true,
		},
		updateAuthor: {
			self: 'http://jira.com/user/1',
			accountId: 'acc123',
			displayName: 'John Doe',
			active: true,
		},
		comment: '',
		created: started,
		updated: started,
		started,
		timeSpent: `${timeSpentSeconds / 3600}h`,
		timeSpentSeconds,
		issueId: '12345',
		issueKey: 'PROJ-123',
	});

	it('should calculate total seconds for a single day', () => {
		const days: Record<string, JiraWorklog[]> = {
			'2025-01-15': [
				createMockWorklog(3600, '2025-01-15T10:00:00.000Z'), // 1 hour
				createMockWorklog(7200, '2025-01-15T14:00:00.000Z'), // 2 hours
			],
		};

		const { result } = renderHook(() =>
			useMonthTotalCalculation(days, 2025, 0),
		); // January 2025

		expect(result.current.totalSeconds).toBe(10800); // 3 hours total
	});

	it('should calculate total seconds across multiple days', () => {
		const days: Record<string, JiraWorklog[]> = {
			'2025-01-15': [
				createMockWorklog(3600, '2025-01-15T10:00:00.000Z'), // 1 hour
				createMockWorklog(7200, '2025-01-15T14:00:00.000Z'), // 2 hours
			],
			'2025-01-16': [
				createMockWorklog(14400, '2025-01-16T09:00:00.000Z'), // 4 hours
			],
			'2025-01-17': [
				createMockWorklog(3600, '2025-01-17T10:00:00.000Z'), // 1 hour
				createMockWorklog(3600, '2025-01-17T11:00:00.000Z'), // 1 hour
				createMockWorklog(3600, '2025-01-17T15:00:00.000Z'), // 1 hour
			],
		};

		const { result } = renderHook(() =>
			useMonthTotalCalculation(days, 2025, 0),
		); // January 2025

		expect(result.current.totalSeconds).toBe(36000); // 10 hours total
	});

	it('should return 0 for empty days', () => {
		const days: Record<string, JiraWorklog[]> = {};

		const { result } = renderHook(() =>
			useMonthTotalCalculation(days, 2025, 0),
		);

		expect(result.current.totalSeconds).toBe(0);
	});

	it('should return 0 for days with empty worklog arrays', () => {
		const days: Record<string, JiraWorklog[]> = {
			'2025-01-15': [],
			'2025-01-16': [],
		};

		const { result } = renderHook(() =>
			useMonthTotalCalculation(days, 2025, 0),
		);

		expect(result.current.totalSeconds).toBe(0);
	});

	it('should handle mixed empty and non-empty days', () => {
		const days: Record<string, JiraWorklog[]> = {
			'2025-01-15': [
				createMockWorklog(3600, '2025-01-15T10:00:00.000Z'), // 1 hour
			],
			'2025-01-16': [],
			'2025-01-17': [
				createMockWorklog(7200, '2025-01-17T10:00:00.000Z'), // 2 hours
			],
		};

		const { result } = renderHook(() =>
			useMonthTotalCalculation(days, 2025, 0),
		);

		expect(result.current.totalSeconds).toBe(10800); // 3 hours total
	});

	it('should recalculate when days data changes', () => {
		const initialDays: Record<string, JiraWorklog[]> = {
			'2025-01-15': [
				createMockWorklog(3600, '2025-01-15T10:00:00.000Z'), // 1 hour
			],
		};

		const { result, rerender } = renderHook(
			({ days, year, month }) => useMonthTotalCalculation(days, year, month),
			{
				initialProps: { days: initialDays, year: 2025, month: 0 },
			},
		);

		expect(result.current.totalSeconds).toBe(3600);

		const updatedDays: Record<string, JiraWorklog[]> = {
			'2025-01-15': [
				createMockWorklog(3600, '2025-01-15T10:00:00.000Z'), // 1 hour
			],
			'2025-01-16': [
				createMockWorklog(7200, '2025-01-16T10:00:00.000Z'), // 2 hours
			],
		};

		rerender({ days: updatedDays, year: 2025, month: 0 });

		expect(result.current.totalSeconds).toBe(10800); // 3 hours total
	});

	it('excludes backdated worklogs from the month total', () => {
		// Viewing February 2025 — backdated submissions show as ghosts/side notes,
		// they do not contribute to the counted total for the month.
		const days: Record<string, JiraWorklog[]> = {
			'2025-02-05': [
				createMockWorklog(3600, '2025-02-05T10:00:00.000Z'), // 1 hour, regular
				{
					...createMockWorklog(7200, '2025-02-05T14:00:00.000Z'),
					comment: 'Original Worklog Date was: 2025/01/20',
				},
			],
			'2025-02-06': [
				createMockWorklog(5400, '2025-02-06T10:00:00.000Z'), // 1.5 hours, regular
				{
					...createMockWorklog(3600, '2025-02-06T14:00:00.000Z'),
					comment: 'Work done earlier. Original Worklog Date was: 2025/01/15',
				},
			],
		};

		const { result } = renderHook(() =>
			useMonthTotalCalculation(days, 2025, 1),
		);

		// Only the non-backdated logs are counted: 3600 + 5400 = 9000 seconds
		expect(result.current.totalSeconds).toBe(9000);
	});

	it('should count only weekday worklogs (weekend worklogs are flagged & skipped)', () => {
		const days: Record<string, JiraWorklog[]> = {};

		// Create 31 days (full January) with 10 worklogs each (30 minutes each)
		for (let day = 1; day <= 31; day++) {
			const dateStr = `2025-01-${day.toString().padStart(2, '0')}`;
			days[dateStr] = [];
			for (let i = 0; i < 10; i++) {
				const hour = (9 + i).toString().padStart(2, '0');
				days[dateStr].push(
					createMockWorklog(1800, `${dateStr}T${hour}:00:00.000Z`),
				); // 0.5 hours each
			}
		}

		const { result } = renderHook(() =>
			useMonthTotalCalculation(days, 2025, 0),
		);

		// 31 days, but 8 fall on weekends (Jan 4,5,11,12,18,19,25,26 2025)
		// Weekend worklogs are flagged and skipped → 23 weekdays × 10 × 1800 = 414000
		expect(result.current.totalSeconds).toBe(414000);
	});
});
