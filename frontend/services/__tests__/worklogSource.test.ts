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
	it('false for a Tempo-ish name with no app accountType', () => {
		// Previously true. A name match alone also matches a human called Tempo,
		// and in auto mode that silently re-routes reads and writes on an
		// instance with no Tempo at all. A missed detection is cheap by
		// comparison — the user picks the mode manually.
		expect(looksLikeTempoManaged([{ displayName: 'Tempo Timesheets' }])).toBe(
			false,
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

describe('looksLikeTempoManaged — false positives (review #13)', () => {
	it('does not fire on a human whose display name contains "tempo"', () => {
		// In auto mode with a token present this would silently re-route every
		// read and write to Tempo on an instance that does not use Tempo.
		expect(
			looksLikeTempoManaged([
				{ accountType: 'atlassian', displayName: 'Tempo Ribeiro' },
			]),
		).toBe(false);
	});

	it('does not fire on an unrelated app account', () => {
		expect(
			looksLikeTempoManaged([
				{ accountType: 'app', displayName: 'Automation for Jira' },
			]),
		).toBe(false);
	});

	it('still fires on the Tempo app account', () => {
		expect(
			looksLikeTempoManaged([
				{ accountType: 'app', displayName: 'Tempo Timesheets' },
			]),
		).toBe(true);
	});

	it('still fires when the app account is among human authors', () => {
		expect(
			looksLikeTempoManaged([
				{ accountType: 'atlassian', displayName: 'Real Person' },
				{ accountType: 'app', displayName: 'Tempo' },
			]),
		).toBe(true);
	});
});

describe('getWorklogSource — scope no longer gates the source (ADA-545)', () => {
	// The temporary guard that pinned team reads to Jira is gone: team reads got
	// their own non-user-scoped fetcher. `scope` is still required, because
	// worklogReadRouter uses it to choose the endpoint — and choosing the
	// per-user endpoint for a team read fails silently rather than loudly.
	const tempoActive = {
		tempoApiToken: 'a-real-token',
		tempoSuspected: true,
		tempoMode: 'tempo',
	} as const;

	it('routes team scope to tempo', () => {
		expect(getWorklogSource({ ...tempoActive, scope: 'team' })).toBe('tempo');
	});

	it('routes personal scope to tempo', () => {
		expect(getWorklogSource({ ...tempoActive, scope: 'personal' })).toBe(
			'tempo',
		);
	});

	it('still honours an explicit jira override for both scopes', () => {
		expect(
			getWorklogSource({ ...tempoActive, tempoMode: 'jira', scope: 'team' }),
		).toBe('jira');
		expect(
			getWorklogSource({
				...tempoActive,
				tempoMode: 'jira',
				scope: 'personal',
			}),
		).toBe('jira');
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
