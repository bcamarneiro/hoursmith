import { describe, expect, it } from 'vitest';
import { computeTeamCoverage } from '../teamCoverage';

const member = (totalSeconds: number) => ({ totalSeconds });

describe('computeTeamCoverage (ADA-488)', () => {
	it('warns when no roster is configured — an author-only board can hide 0h members', () => {
		const coverage = computeTeamCoverage([member(3600), member(0)], '');
		expect(coverage.rosterConfigured).toBe(false);
		expect(coverage.rosterSize).toBeNull();
		expect(coverage.loggedCount).toBe(1);
		expect(coverage.noWorklogCount).toBe(0);
		expect(coverage.hasWarning).toBe(true);
	});

	it('reports full coverage when every roster member logged time', () => {
		const coverage = computeTeamCoverage(
			[member(3600), member(7200)],
			'alice@example.com, bob@example.com',
		);
		expect(coverage.rosterConfigured).toBe(true);
		expect(coverage.rosterSize).toBe(2);
		expect(coverage.loggedCount).toBe(2);
		expect(coverage.noWorklogCount).toBe(0);
		expect(coverage.hasWarning).toBe(false);
	});

	it('counts roster members with no worklogs as a visibility gap', () => {
		// Roster of 3; only 2 logged → 1 member with no worklogs found.
		const coverage = computeTeamCoverage(
			[member(3600), member(7200), member(0)],
			'alice@example.com, bob@example.com, charlie@example.com',
		);
		expect(coverage.rosterSize).toBe(3);
		expect(coverage.loggedCount).toBe(2);
		expect(coverage.noWorklogCount).toBe(1);
		expect(coverage.hasWarning).toBe(true);
	});

	it('ignores blank/whitespace roster entries when sizing the roster', () => {
		const coverage = computeTeamCoverage(
			[member(3600)],
			' alice@example.com , , ',
		);
		expect(coverage.rosterSize).toBe(1);
		expect(coverage.noWorklogCount).toBe(0);
		expect(coverage.hasWarning).toBe(false);
	});
});
