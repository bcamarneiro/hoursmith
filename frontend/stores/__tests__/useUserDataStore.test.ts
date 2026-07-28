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

	it('sets and clears defaultReportPresetId', () => {
		act(() => {
			useUserDataStore.getState().saveReportPreset({
				id: 'test-preset',
				label: 'Test Preset',
				viewMode: 'weekly',
				searchQuery: '',
				onlyAttentionNeeded: false,
				managerMode: false,
				trendWeeks: 4,
				sortField: 'name',
				sortDirection: 'asc',
				selectedUser: null,
			});
		});

		const presetId = useUserDataStore.getState().reportPresets[0].id;

		act(() => {
			useUserDataStore.getState().setDefaultReportPreset(presetId);
		});

		expect(useUserDataStore.getState().defaultReportPresetId).toBe(presetId);

		act(() => {
			useUserDataStore.getState().setDefaultReportPreset(null);
		});

		expect(useUserDataStore.getState().defaultReportPresetId).toBeNull();
	});

	it('clears defaultReportPresetId when the preset is removed', () => {
		act(() => {
			useUserDataStore.getState().saveReportPreset({
				id: 'test-preset',
				label: 'Test Preset',
				viewMode: 'weekly',
				searchQuery: '',
				onlyAttentionNeeded: false,
				managerMode: false,
				trendWeeks: 4,
				sortField: 'name',
				sortDirection: 'asc',
				selectedUser: null,
			});
		});

		const presetId = useUserDataStore.getState().reportPresets[0].id;

		act(() => {
			useUserDataStore.getState().setDefaultReportPreset(presetId);
		});

		expect(useUserDataStore.getState().defaultReportPresetId).toBe(presetId);

		act(() => {
			useUserDataStore.getState().removeReportPreset(presetId);
		});

		expect(useUserDataStore.getState().defaultReportPresetId).toBeNull();
		expect(useUserDataStore.getState().reportPresets).toHaveLength(0);
	});

	it('validates defaultReportPresetId during merge', async () => {
		const { useUserDataStore: store } = await import('../useUserDataStore');
		const merge = (store.persist.getOptions().merge ?? ((a) => a as never)) as (
			a: unknown,
			b: unknown,
		) => unknown;

		// Test with valid default ID
		const validPreset = {
			id: 'preset-1',
			label: 'Test',
			viewMode: 'weekly' as const,
			searchQuery: '',
			onlyAttentionNeeded: false,
			managerMode: false,
			trendWeeks: 4,
			sortField: 'name' as const,
			sortDirection: 'asc' as const,
			selectedUser: null,
		};

		const persistedWithValidDefault = {
			reportPresets: [validPreset],
			defaultReportPresetId: 'preset-1',
		};

		const mergedValid = merge(
			persistedWithValidDefault,
			store.getState(),
		) as ReturnType<typeof store.getState>;
		expect(mergedValid.defaultReportPresetId).toBe('preset-1');

		// Test with invalid default ID (preset doesn't exist)
		const persistedWithInvalidDefault = {
			reportPresets: [validPreset],
			defaultReportPresetId: 'non-existent-id',
		};

		const mergedInvalid = merge(
			persistedWithInvalidDefault,
			store.getState(),
		) as ReturnType<typeof store.getState>;
		expect(mergedInvalid.defaultReportPresetId).toBeNull();
	});
});
