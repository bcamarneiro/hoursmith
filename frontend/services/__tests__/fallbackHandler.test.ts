/**
 * Tests for the fallback logic handler.
 */
import { describe, expect, it } from 'vitest';
import {
	evaluateDashboardFallback,
	evaluateFallbackState,
	type FallbackMode,
} from '../fallbackHandler';

// ---------------------------------------------------------------------------
// evaluateFallbackState
// ---------------------------------------------------------------------------

describe('evaluateFallbackState', () => {
	it('returns normal mode when no services have errors', () => {
		const state = evaluateFallbackState([
			{ source: 'worklogs', hasError: false, errorMessage: null },
			{ source: 'jira', hasError: false, errorMessage: null },
		]);
		expect(state.mode).toBe('normal');
		expect(state.availableActions.addManualEntry).toBe(true);
		expect(state.availableActions.exportData).toBe(true);
	});

	it('returns degraded mode when a non-core suggestion source fails', () => {
		const state = evaluateFallbackState([
			{ source: 'worklogs', hasError: false, errorMessage: null },
			{
				source: 'gitlab',
				hasError: true,
				errorMessage: 'timeout',
			},
		]);
		expect(state.mode).toBe('degraded');
		expect(state.availableActions.exportData).toBe(true);
		expect(state.availableActions.addManualEntry).toBe(true);
	});

	it('returns manual-entry mode when worklogs fail (non-blocking error class)', () => {
		const state = evaluateFallbackState([
			{
				source: 'worklogs',
				hasError: true,
				errorMessage: 'Jira search returned 500',
			},
		]);
		expect(state.mode).toBe('manual-entry');
		expect(state.availableActions.exportData).toBe(false);
		expect(state.availableActions.addManualEntry).toBe(true);
	});

	it('returns manual-entry (not offline) for "not found" worklog errors (regression — too broad a blocking pattern)', () => {
		// "not found" can match legitimate Jira 404s (e.g. "Issue not found"),
		// not just connectivity failures. It must NOT trigger offline mode.
		const state = evaluateFallbackState([
			{
				source: 'worklogs',
				hasError: true,
				errorMessage: 'Issue not found',
			},
		]);
		expect(state.mode).toBe('manual-entry');
		expect(state.availableActions.exportData).toBe(false);
		expect(state.availableActions.addManualEntry).toBe(true);
	});

	it('returns offline mode when a blocking error is detected', () => {
		const state = evaluateFallbackState([
			{
				source: 'worklogs',
				hasError: true,
				errorMessage: 'invalid token',
			},
		]);
		expect(state.mode).toBe('offline');
		expect(state.availableActions.exportData).toBe(false);
		expect(state.availableActions.copyPreviousWeek).toBe(false);
	});

	it('returns offline mode when CORS / network errors occur', () => {
		const cases = [
			'Failed to fetch',
			'NetworkError',
			'CORS policy blocked',
			'proxy returned 502',
		];

		for (const msg of cases) {
			const state = evaluateFallbackState([
				{ source: 'worklogs', hasError: true, errorMessage: msg },
			]);
			expect(state.mode).toBe('offline');
		}
	});

	it('returns offline mode on 401/403 auth failures', () => {
		const state = evaluateFallbackState([
			{
				source: 'worklogs',
				hasError: true,
				errorMessage: 'Jira search (Unauthorized)',
			},
		]);
		expect(state.mode).toBe('offline');
	});

	it('returns offline mode on session expiry', () => {
		const state = evaluateFallbackState([
			{
				source: 'jira',
				hasError: true,
				errorMessage: 'Hoursmith session expired',
			},
		]);
		expect(state.mode).toBe('offline');
	});

	it('picks the most severe mode when multiple services fail', () => {
		// worklogs fail (manual-entry), but a suggestion source also has a
		// blocking error — offline wins.
		const state = evaluateFallbackState([
			{
				source: 'worklogs',
				hasError: true,
				errorMessage: 'timeout',
			},
			{
				source: 'gitlab',
				hasError: true,
				errorMessage: 'Forbidden',
			},
		]);
		expect(state.mode).toBe('offline');
	});

	it('classifies per-service severity in the returned service list', () => {
		const state = evaluateFallbackState([
			{ source: 'worklogs', hasError: true, errorMessage: 'timeout' },
			{ source: 'calendar', hasError: true, errorMessage: null },
			{ source: 'rescuetime', hasError: false, errorMessage: null },
		]);

		const wl = state.services.find((s) => s.source === 'worklogs');
		expect(wl?.severity).toBe('fallback-required');

		const cal = state.services.find((s) => s.source === 'calendar');
		expect(cal?.severity).toBe('non-blocking');

		const rt = state.services.find((s) => s.source === 'rescuetime');
		expect(rt?.severity).toBe('non-blocking');
		expect(rt?.hasError).toBe(false);
	});

	it('returns normal mode for an empty service list', () => {
		const state = evaluateFallbackState([]);
		expect(state.mode).toBe('normal');
		expect(state.services).toHaveLength(0);
	});

	it('includes human-readable fallbackBehavior for every service', () => {
		const sources = [
			'worklogs',
			'jira',
			'gitlab',
			'calendar',
			'rescuetime',
		] as const;

		const state = evaluateFallbackState(
			sources.map((s) => ({
				source: s,
				hasError: true,
				errorMessage: 'err',
			})),
		);

		for (const s of state.services) {
			expect(s.fallbackBehavior).toBeTruthy();
			expect(typeof s.fallbackBehavior).toBe('string');
		}
	});
});

// ---------------------------------------------------------------------------
// evaluateDashboardFallback
// ---------------------------------------------------------------------------

describe('evaluateDashboardFallback', () => {
	it('maps the dashboard error shape to a full fallback state', () => {
		const state = evaluateDashboardFallback({
			worklogsError: 'Failed to fetch',
			jiraSuggestionsError: null,
			gitlabSuggestionsError: 'timeout',
			calendarSuggestionsError: null,
			rescueTimeError: null,
		});

		expect(state.mode).toBe('offline');
		expect(state.services).toHaveLength(5);
		expect(state.services[0].source).toBe('worklogs');
		expect(state.services[2].source).toBe('gitlab');
	});

	it('returns normal when all dashboard errors are null', () => {
		const state = evaluateDashboardFallback({
			worklogsError: null,
			jiraSuggestionsError: null,
			gitlabSuggestionsError: null,
			calendarSuggestionsError: null,
			rescueTimeError: null,
		});

		expect(state.mode).toBe('normal');
	});

	it('returns correct available actions for each mode', () => {
		const modes: FallbackMode[] = [
			'normal',
			'degraded',
			'manual-entry',
			'offline',
		];

		for (const mode of modes) {
			// Build an error snapshot that triggers the desired mode
			const snapshot: Record<string, string | null> = {
				worklogsError: null,
				jiraSuggestionsError: null,
				gitlabSuggestionsError: null,
				calendarSuggestionsError: null,
				rescueTimeError: null,
			};

			if (mode === 'degraded') {
				snapshot.gitlabSuggestionsError = 'timeout';
			} else if (mode === 'manual-entry') {
				snapshot.worklogsError = '500 Internal Server Error';
			} else if (mode === 'offline') {
				snapshot.worklogsError = 'Unauthorized';
			}

			const state = evaluateDashboardFallback(
				snapshot as {
					worklogsError: string | null;
					jiraSuggestionsError: string | null;
					gitlabSuggestionsError: string | null;
					calendarSuggestionsError: string | null;
					rescueTimeError: string | null;
				},
			);

			expect(state.mode).toBe(mode);
			expect(state.availableActions.addManualEntry).toBe(true);
			expect(state.availableActions.useFavorites).toBe(true);
			expect(state.availableActions.useTemplates).toBe(true);

			if (mode === 'normal' || mode === 'degraded') {
				expect(state.availableActions.exportData).toBe(true);
				expect(state.availableActions.copyPreviousWeek).toBe(true);
			}

			if (mode === 'manual-entry') {
				expect(state.availableActions.exportData).toBe(false);
				expect(state.availableActions.copyPreviousWeek).toBe(true);
			}

			if (mode === 'offline') {
				expect(state.availableActions.exportData).toBe(false);
				expect(state.availableActions.copyPreviousWeek).toBe(false);
				expect(state.availableActions.viewSuggestions).toBe(false);
			}
		}
	});
});
