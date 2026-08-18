// @vitest-environment happy-dom

import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUserDataStore } from '../useUserDataStore';

function createMemoryStorage(): Storage {
	let store: Record<string, string> = {};

	return {
		get length() {
			return Object.keys(store).length;
		},
		clear() {
			store = {};
		},
		getItem(key) {
			return store[key] ?? null;
		},
		key(index) {
			return Object.keys(store)[index] ?? null;
		},
		removeItem(key) {
			delete store[key];
		},
		setItem(key, value) {
			store[key] = value;
		},
	};
}

describe('useUserDataStore', () => {
	beforeEach(() => {
		Object.defineProperty(globalThis, 'localStorage', {
			value: createMemoryStorage(),
			configurable: true,
		});

		act(() => {
			useUserDataStore.setState({
				favorites: [],
				templates: [],
				commentPresets: [],
				dayNotes: {},
				calendarMappings: [],
				reportPresets: [],
				wakatimeMappings: [],
			});
		});
	});

	it('normalizes favorite issue keys and prevents duplicates', () => {
		act(() => {
			useUserDataStore.getState().addFavorite({
				issueKey: ' proj-123 ',
				issueSummary: ' Test issue ',
				defaultTimeSpent: ' 1h ',
				defaultSeconds: 3600,
			});
			useUserDataStore.getState().addFavorite({
				issueKey: 'PROJ-123',
				issueSummary: 'Duplicate',
				defaultTimeSpent: '2h',
				defaultSeconds: 7200,
			});
		});

		expect(useUserDataStore.getState().favorites).toEqual([
			{
				issueKey: 'PROJ-123',
				issueSummary: 'Test issue',
				defaultTimeSpent: '1h',
				defaultSeconds: 3600,
			},
		]);
	});

	it('deduplicates comment presets case-insensitively', () => {
		act(() => {
			useUserDataStore.getState().addCommentPreset(' Standup ');
			useUserDataStore.getState().addCommentPreset('standup');
			useUserDataStore.getState().addCommentPreset('Review');
		});

		expect(useUserDataStore.getState().commentPresets).toEqual([
			'Standup',
			'Review',
		]);
	});

	it('normalizes calendar mappings and updates them safely', () => {
		act(() => {
			useUserDataStore.getState().addCalendarMapping({
				issueKey: 'proj-9',
				patterns: [' Team Sync '],
			});
			useUserDataStore.getState().updateCalendarMapping('proj-9', {
				issueKey: 'proj-10',
				patterns: [' Delivery Sync ', 'delivery sync'],
			});
		});

		expect(useUserDataStore.getState().calendarMappings).toEqual([
			{
				issueKey: 'PROJ-10',
				issueSummary: undefined,
				patterns: ['Delivery Sync'],
			},
		]);
	});

	it('addPatternToMapping appends to existing mapping or creates a new one', () => {
		act(() => {
			useUserDataStore
				.getState()
				.addPatternToMapping('proj-11', 'Daily standup');
			useUserDataStore
				.getState()
				.addPatternToMapping('proj-11', 'Daily Sync', 'Daily ceremonies');
			// Duplicate pattern (case-insensitive) is a no-op.
			useUserDataStore
				.getState()
				.addPatternToMapping('proj-11', 'daily standup');
			useUserDataStore.getState().addPatternToMapping('proj-12', 'Retro');
		});

		expect(useUserDataStore.getState().calendarMappings).toEqual([
			{
				issueKey: 'PROJ-11',
				issueSummary: 'Daily ceremonies',
				patterns: ['Daily standup', 'Daily Sync'],
			},
			{
				issueKey: 'PROJ-12',
				issueSummary: undefined,
				patterns: ['Retro'],
			},
		]);
	});

	it('sorts and deduplicates template weekdays on insert', () => {
		act(() => {
			useUserDataStore.getState().addTemplate({
				id: 'template-1',
				issueKey: 'proj-1',
				issueSummary: 'Template',
				timeSpent: ' 30m ',
				seconds: 1800,
				comment: ' recurring ',
				daysOfWeek: [5, 1, 1, 3],
				enabled: true,
			});
		});

		expect(useUserDataStore.getState().templates).toEqual([
			{
				id: 'template-1',
				issueKey: 'PROJ-1',
				issueSummary: 'Template',
				timeSpent: '30m',
				seconds: 1800,
				comment: 'recurring',
				daysOfWeek: [1, 3, 5],
				enabled: true,
			},
		]);
	});

	it('adds WakaTime mappings with normalized values and prevents duplicates', () => {
		act(() => {
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: ' hoursmith ',
				issueKey: ' proj-1 ',
				issueSummary: ' Hoursmith Dev ',
			});
			// Duplicate (case-insensitive project name) is a no-op
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: 'Hoursmith',
				issueKey: 'PROJ-2',
				issueSummary: 'Different issue',
			});
			// Different project is added
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: 'other-project',
				issueKey: 'PROJ-3',
			});
		});

		const mappings = useUserDataStore.getState().wakatimeMappings;
		expect(mappings).toHaveLength(2);
		expect(mappings[0]).toEqual({
			projectName: 'hoursmith',
			issueKey: 'PROJ-1',
			issueSummary: 'Hoursmith Dev',
		});
		expect(mappings[1]).toEqual({
			projectName: 'other-project',
			issueKey: 'PROJ-3',
			issueSummary: undefined,
		});
	});

	it('ignores WakaTime mappings with empty projectName or issueKey', () => {
		act(() => {
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: '',
				issueKey: 'PROJ-1',
			});
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: 'valid',
				issueKey: '',
			});
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: '  ',
				issueKey: '  ',
			});
		});

		expect(useUserDataStore.getState().wakatimeMappings).toEqual([]);
	});

	it('removes WakaTime mappings case-insensitively', () => {
		act(() => {
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: 'hoursmith',
				issueKey: 'PROJ-1',
			});
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: 'other-project',
				issueKey: 'PROJ-2',
			});
			useUserDataStore.getState().removeWakaTimeMapping(' Hoursmith ');
		});

		const mappings = useUserDataStore.getState().wakatimeMappings;
		expect(mappings).toHaveLength(1);
		expect(mappings[0]?.projectName).toBe('other-project');
	});

	it('updates WakaTime mappings and prevents duplicate project names', () => {
		act(() => {
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: 'hoursmith',
				issueKey: 'PROJ-1',
				issueSummary: 'Original',
			});
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: 'other-project',
				issueKey: 'PROJ-2',
			});
			// Update hoursmith to point to a different issue
			useUserDataStore.getState().updateWakaTimeMapping('hoursmith', {
				projectName: 'hoursmith',
				issueKey: 'PROJ-99',
				issueSummary: 'Updated',
			});
		});

		const mappings = useUserDataStore.getState().wakatimeMappings;
		expect(mappings).toHaveLength(2);
		const updated = mappings.find(
			(m) => m.projectName === 'hoursmith',
		);
		expect(updated).toEqual({
			projectName: 'hoursmith',
			issueKey: 'PROJ-99',
			issueSummary: 'Updated',
		});
	});

	it('updateWakaTimeMapping rejects rename to an existing project name', () => {
		act(() => {
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: 'project-a',
				issueKey: 'PROJ-1',
			});
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: 'project-b',
				issueKey: 'PROJ-2',
			});
			// Try to rename project-a to project-b (duplicate) — should be rejected
			useUserDataStore.getState().updateWakaTimeMapping('project-a', {
				projectName: 'project-b',
				issueKey: 'PROJ-1',
			});
		});

		const mappings = useUserDataStore.getState().wakatimeMappings;
		expect(mappings).toHaveLength(2);
		// project-a should be unchanged
		expect(mappings.find((m) => m.projectName === 'project-a')?.issueKey).toBe('PROJ-1');
		expect(mappings.find((m) => m.projectName === 'project-b')?.issueKey).toBe('PROJ-2');
	});

	it('updateWakaTimeMapping ignores updates with empty projectName or issueKey', () => {
		act(() => {
			useUserDataStore.getState().addWakaTimeMapping({
				projectName: 'hoursmith',
				issueKey: 'PROJ-1',
			});
			useUserDataStore.getState().updateWakaTimeMapping('hoursmith', {
				projectName: '',
				issueKey: 'PROJ-2',
			});
		});

		const mappings = useUserDataStore.getState().wakatimeMappings;
		expect(mappings).toHaveLength(1);
		expect(mappings[0]?.issueKey).toBe('PROJ-1');
	});

	it('replaces calendar mappings and merges duplicates by issue key', () => {
		act(() => {
			useUserDataStore.getState().replaceCalendarMappings([
				{ issueKey: 'proj-3', patterns: [' Planning '] },
				// Duplicate issueKey merges its patterns into the first entry.
				{ issueKey: 'PROJ-3', patterns: ['planning', 'Sprint Planning'] },
				{ issueKey: ' proj-5 ', patterns: ['Retro'] },
			]);
		});

		expect(useUserDataStore.getState().calendarMappings).toEqual([
			{
				issueKey: 'PROJ-3',
				issueSummary: undefined,
				patterns: ['Planning', 'Sprint Planning'],
			},
			{ issueKey: 'PROJ-5', issueSummary: undefined, patterns: ['Retro'] },
		]);
	});

	it('saves and updates report presets with normalized values', () => {
		act(() => {
			useUserDataStore.getState().saveReportPreset({
				id: ' weekly-attention ',
				label: ' Weekly Attention ',
				viewMode: 'weekly',
				searchQuery: ' Team ',
				onlyAttentionNeeded: true,
				managerMode: true,
				trendWeeks: 8,
				sortField: 'gap',
				sortDirection: 'desc',
				selectedUser: '  ',
			});
			useUserDataStore.getState().saveReportPreset({
				id: 'weekly-attention',
				label: 'Weekly Attention Updated',
				viewMode: 'monthly',
				searchQuery: 'Bruno',
				onlyAttentionNeeded: false,
				managerMode: false,
				trendWeeks: 99,
				sortField: 'name',
				sortDirection: 'asc',
				selectedUser: 'Bruno',
			});
		});

		expect(useUserDataStore.getState().reportPresets).toEqual([
			{
				id: 'weekly-attention',
				label: 'Weekly Attention Updated',
				viewMode: 'monthly',
				searchQuery: 'Bruno',
				onlyAttentionNeeded: false,
				managerMode: false,
				trendWeeks: 6,
				sortField: 'name',
				sortDirection: 'asc',
				selectedUser: 'Bruno',
			},
		]);
	});

	it('removes report presets by id', () => {
		act(() => {
			useUserDataStore.getState().saveReportPreset({
				id: 'preset-1',
				label: 'Preset 1',
				viewMode: 'weekly',
				searchQuery: '',
				onlyAttentionNeeded: false,
				managerMode: false,
				trendWeeks: 6,
				sortField: 'name',
				sortDirection: 'asc',
				selectedUser: '',
			});
			useUserDataStore.getState().removeReportPreset('preset-1');
		});

		expect(useUserDataStore.getState().reportPresets).toEqual([]);
	});
});

describe('useUserDataStore — defensive merge', () => {
	it('drops malformed favorite entries silently', async () => {
		const { useUserDataStore: store } = await import('../useUserDataStore');
		const merge = (store.persist.getOptions().merge ?? ((a) => a as never)) as (
			a: unknown,
			b: unknown,
		) => unknown;
		const persisted = {
			favorites: [
				{ issueKey: 123 },
				{ issueKey: 'PROJ-1', defaultTimeSpent: '1h', defaultSeconds: 3600 },
				{ issueKey: '', defaultTimeSpent: '', defaultSeconds: 0 },
			],
			templates: 'not-an-array',
			commentPresets: ['Hello', 42, ''],
			dayNotes: 'not-an-object',
			calendarMappings: [{ pattern: 'a', issueKey: '' }, { pattern: '' }],
			reportPresets: 'broken',
		};
		const merged = merge(persisted, store.getState()) as ReturnType<
			typeof store.getState
		>;
		expect(merged.favorites.map((f) => f.issueKey)).toEqual(['PROJ-1']);
		expect(merged.templates).toEqual([]);
		expect(merged.commentPresets).toEqual(['Hello']);
		expect(merged.dayNotes).toEqual({});
		expect(merged.calendarMappings).toEqual([]);
		expect(merged.reportPresets).toEqual([]);
	});

	it('preserves valid entries through the merge', async () => {
		const { useUserDataStore: store } = await import('../useUserDataStore');
		const merge = (store.persist.getOptions().merge ?? ((a) => a as never)) as (
			a: unknown,
			b: unknown,
		) => unknown;
		const persisted = {
			favorites: [
				{
					issueKey: 'PROJ-99',
					issueSummary: 'Keep me',
					defaultTimeSpent: '2h',
					defaultSeconds: 7200,
				},
			],
			dayNotes: { '2026-05-01': 'note' },
		};
		const merged = merge(persisted, store.getState()) as ReturnType<
			typeof store.getState
		>;
		expect(merged.favorites).toHaveLength(1);
		expect(merged.favorites[0].issueKey).toBe('PROJ-99');
		expect(merged.dayNotes).toEqual({ '2026-05-01': 'note' });
	});
});
