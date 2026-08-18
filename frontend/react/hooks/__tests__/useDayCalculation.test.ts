import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JiraWorklog } from '../../../../types/JiraWorklog';
import { useDayCalculation } from '../useDayCalculation';

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

describe('useDayCalculation', () => {
	describe('weekday calculations', () => {
		it('should calculate correct totals for a full 8h workday', () => {
			const worklogs = [createMockWorklog(28800, '2025-10-15T09:00:00.000Z')];

			const { result } = renderHook(() => useDayCalculation(worklogs, false));

			expect(result.current.dayTotalSeconds).toBe(28800);
			expect(result.current.baselineSeconds).toBe(28800);
			expect(result.current.effectiveSeconds).toBe(28800);
			expect(result.current.missingSeconds).toBe(0);
		});

		it('should calculate missing hours for partial workday', () => {
			const worklogs = [createMockWorklog(14400, '2025-10-15T09:00:00.000Z')];

			const { result } = renderHook(() => useDayCalculation(worklogs, false));

			expect(result.current.dayTotalSeconds).toBe(14400);
			expect(result.current.baselineSeconds).toBe(28800);
			expect(result.current.effectiveSeconds).toBe(14400);
			expect(result.current.missingSeconds).toBe(14400);
		});

		it('should not show missing for overtime', () => {
			const worklogs = [createMockWorklog(36000, '2025-10-15T09:00:00.000Z')];

			const { result } = renderHook(() => useDayCalculation(worklogs, false));

			expect(result.current.dayTotalSeconds).toBe(36000);
			expect(result.current.effectiveSeconds).toBe(36000);
			expect(result.current.missingSeconds).toBe(0);
		});

		it('should handle multiple worklogs on same day', () => {
			const worklogs = [
				createMockWorklog(14400, '2025-10-15T09:00:00.000Z'),
				createMockWorklog(10800, '2025-10-15T14:00:00.000Z'),
			];

			const { result } = renderHook(() => useDayCalculation(worklogs, false));

			expect(result.current.dayTotalSeconds).toBe(25200);
			expect(result.current.missingSeconds).toBe(3600);
		});

		it('should handle empty worklogs', () => {
			const { result } = renderHook(() => useDayCalculation([], false));

			expect(result.current.dayTotalSeconds).toBe(0);
			expect(result.current.effectiveSeconds).toBe(0);
			expect(result.current.missingSeconds).toBe(28800);
		});
	});

	describe('weekend calculations', () => {
		it('skips worklogs on weekends (flagged) and sets zero baseline', () => {
			const worklogs = [createMockWorklog(14400, '2025-10-18T09:00:00.000Z')];

			const { result } = renderHook(() => useDayCalculation(worklogs, true));

			expect(result.current.dayTotalSeconds).toBe(0);
			expect(result.current.baselineSeconds).toBe(0);
			expect(result.current.missingSeconds).toBe(0);
		});

		it('should handle empty weekend', () => {
			const { result } = renderHook(() => useDayCalculation([], true));

			expect(result.current.dayTotalSeconds).toBe(0);
			expect(result.current.effectiveSeconds).toBe(0);
			expect(result.current.missingSeconds).toBe(0);
		});
	});

	describe('absence calculations', () => {
		it('treats approved time off like a zero-target day', () => {
			const { result } = renderHook(() => useDayCalculation([], false, true));

			expect(result.current.baselineSeconds).toBe(0);
			expect(result.current.missingSeconds).toBe(0);
		});
	});

	describe('backdated worklogs', () => {
		it('excludes backdated submissions from dayTotalSeconds', () => {
			const regular = createMockWorklog(28800, '2025-10-15T09:00:00.000Z');
			const backdated: JiraWorklog = {
				...createMockWorklog(14400, '2025-10-15T18:00:00.000Z'),
				comment: 'Original Worklog Date was: 2025/10/01',
			};

			const { result } = renderHook(() =>
				useDayCalculation([regular, backdated], false),
			);

			expect(result.current.dayTotalSeconds).toBe(28800);
			expect(result.current.backdatedSeconds).toBe(14400);
			expect(result.current.missingSeconds).toBe(0);
		});

		it('reports backdatedSeconds even when there are no other logs', () => {
			const backdated: JiraWorklog = {
				...createMockWorklog(7200, '2025-10-15T18:00:00.000Z'),
				comment: 'Original Worklog Date was: 2025/10/01',
			};

			const { result } = renderHook(() =>
				useDayCalculation([backdated], false),
			);

			expect(result.current.dayTotalSeconds).toBe(0);
			expect(result.current.backdatedSeconds).toBe(7200);
			expect(result.current.missingSeconds).toBe(28800);
		});
	});

	describe('reactivity', () => {
		it('should recalculate when worklogs change', () => {
			const initialWorklogs = [
				createMockWorklog(14400, '2025-10-15T09:00:00.000Z'),
			];

			const { result, rerender } = renderHook(
				({ worklogs, isWeekend }) => useDayCalculation(worklogs, isWeekend),
				{
					initialProps: {
						worklogs: initialWorklogs,
						isWeekend: false,
					},
				},
			);

			expect(result.current.dayTotalSeconds).toBe(14400);

			const updatedWorklogs = [
				createMockWorklog(14400, '2025-10-15T09:00:00.000Z'),
				createMockWorklog(14400, '2025-10-15T14:00:00.000Z'),
			];

			rerender({
				worklogs: updatedWorklogs,
				isWeekend: false,
			});

			expect(result.current.dayTotalSeconds).toBe(28800);
		});
	});
});
