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

describe('getWorklogSource', () => {
	const base = { tempoApiToken: '', tempoSuspected: false };
	it('auto + no token → jira', () => {
		expect(getWorklogSource({ ...base, tempoMode: 'auto' })).toBe('jira');
	});
	it('auto + token + suspected → tempo', () => {
		expect(
			getWorklogSource({
				tempoMode: 'auto',
				tempoApiToken: 't',
				tempoSuspected: true,
			}),
		).toBe('tempo');
	});
	it('auto + token + not suspected → jira', () => {
		expect(
			getWorklogSource({
				tempoMode: 'auto',
				tempoApiToken: 't',
				tempoSuspected: false,
			}),
		).toBe('jira');
	});
	it('tempo + token → tempo', () => {
		expect(
			getWorklogSource({
				tempoMode: 'tempo',
				tempoApiToken: 't',
				tempoSuspected: false,
			}),
		).toBe('tempo');
	});
	it('tempo + no token → jira (token required)', () => {
		expect(
			getWorklogSource({
				tempoMode: 'tempo',
				tempoApiToken: '',
				tempoSuspected: true,
			}),
		).toBe('jira');
	});
	it('jira always → jira', () => {
		expect(
			getWorklogSource({
				tempoMode: 'jira',
				tempoApiToken: 't',
				tempoSuspected: true,
			}),
		).toBe('jira');
	});
});
