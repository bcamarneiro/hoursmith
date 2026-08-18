import { describe, expect, it } from 'vitest';
import { getWorklogSource, looksLikeTempoManaged } from '../worklogSource';

describe('looksLikeTempoManaged', () => {
	it('true for an app-account author', () => {
		expect(
			looksLikeTempoManaged([
				{ accountType: 'app', displayName: 'Timesheets by Tempo' },
			]),
		).toBe(true);
	});
	it('true for a Tempo display name even without accountType', () => {
		expect(looksLikeTempoManaged([{ displayName: 'Tempo Timesheets' }])).toBe(
			true,
		);
	});
	it('false for ordinary human authors', () => {
		expect(
			looksLikeTempoManaged([{ accountType: 'atlassian', displayName: 'Ana' }]),
		).toBe(false);
	});
	it('false for an empty list', () => {
		expect(looksLikeTempoManaged([])).toBe(false);
	});
});

describe('getWorklogSource — team scope guard (ADA-545)', () => {
	// Regression: every Tempo fetcher is pinned to GET /4/worklogs/user/{accountId},
	// so letting a team-scoped read reach Tempo silently drops every teammate —
	// the Reports table renders plausible-but-partial numbers with no error.
	const tempoIsOtherwiseActive = {
		tempoApiToken: 'a-real-token',
		tempoSuspected: true,
	} as const;

	it('forces jira for team scope even when auto-detection would pick tempo', () => {
		expect(
			getWorklogSource({
				...tempoIsOtherwiseActive,
				tempoMode: 'auto',
				scope: 'team',
			}),
		).toBe('jira');
	});

	it('forces jira for team scope even when tempo is selected explicitly', () => {
		expect(
			getWorklogSource({
				...tempoIsOtherwiseActive,
				tempoMode: 'tempo',
				scope: 'team',
			}),
		).toBe('jira');
	});

	it('still routes the same config to tempo for personal scope', () => {
		expect(
			getWorklogSource({
				...tempoIsOtherwiseActive,
				tempoMode: 'tempo',
				scope: 'personal',
			}),
		).toBe('tempo');
	});
});

describe('getWorklogSource', () => {
	const base = {
		tempoApiToken: '',
		tempoSuspected: false,
		scope: 'personal' as const,
	};
	it('auto + no token → jira', () => {
		expect(getWorklogSource({ ...base, tempoMode: 'auto' })).toBe('jira');
	});
	it('auto + token + suspected → tempo', () => {
		expect(
			getWorklogSource({
				tempoMode: 'auto',
				tempoApiToken: 't',
				tempoSuspected: true,
				scope: 'personal' as const,
			}),
		).toBe('tempo');
	});
	it('auto + token + not suspected → jira', () => {
		expect(
			getWorklogSource({
				tempoMode: 'auto',
				tempoApiToken: 't',
				tempoSuspected: false,
				scope: 'personal' as const,
			}),
		).toBe('jira');
	});
	it('tempo + token → tempo', () => {
		expect(
			getWorklogSource({
				tempoMode: 'tempo',
				tempoApiToken: 't',
				tempoSuspected: false,
				scope: 'personal' as const,
			}),
		).toBe('tempo');
	});
	it('tempo + no token → jira (token required)', () => {
		expect(
			getWorklogSource({
				tempoMode: 'tempo',
				tempoApiToken: '',
				tempoSuspected: true,
				scope: 'personal' as const,
			}),
		).toBe('jira');
	});
	it('jira always → jira', () => {
		expect(
			getWorklogSource({
				tempoMode: 'jira',
				tempoApiToken: 't',
				tempoSuspected: true,
				scope: 'personal' as const,
			}),
		).toBe('jira');
	});
});
