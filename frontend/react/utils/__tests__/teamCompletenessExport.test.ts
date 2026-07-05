import { describe, expect, it } from 'vitest';
import type { TeamMemberSummary } from '../../../services/teamService';
import {
	buildTeamCompletenessCsv,
	buildTeamCompletenessRows,
	buildTeamCompletenessWorkbook,
} from '../teamCompletenessExport';

const HOUR = 3600;

function member(overrides: Partial<TeamMemberSummary>): TeamMemberSummary {
	return {
		email: 'x@example.com',
		displayName: 'X',
		dailyHours: new Map(),
		totalSeconds: 0,
		targetSeconds: 0,
		gapSeconds: 0,
		...overrides,
	};
}

describe('buildTeamCompletenessRows (ADA-390)', () => {
	it('computes expected/logged hours, completeness %, and on-time label', () => {
		const [row] = buildTeamCompletenessRows([
			member({
				displayName: 'Alice',
				email: 'alice@example.com',
				targetSeconds: 40 * HOUR,
				totalSeconds: 36 * HOUR,
				onTimeStatus: 'on-time',
			}),
		]);
		expect(row).toEqual({
			displayName: 'Alice',
			email: 'alice@example.com',
			expectedHours: 40,
			loggedHours: 36,
			completenessPct: 90,
			onTimeStatus: 'On time',
		});
	});

	it('guards a zero expected target (no NaN) and dashes a missing on-time status', () => {
		const [zeroLogged, zeroTargetButLogged] = buildTeamCompletenessRows([
			member({ targetSeconds: 0, totalSeconds: 0 }),
			member({ targetSeconds: 0, totalSeconds: 4 * HOUR }),
		]);
		expect(zeroLogged.completenessPct).toBe(0);
		expect(zeroLogged.onTimeStatus).toBe('—');
		// Logged something against no target reads as fully covered, not Infinity.
		expect(zeroTargetButLogged.completenessPct).toBe(100);
	});
});

describe('buildTeamCompletenessCsv (ADA-390)', () => {
	const csv = buildTeamCompletenessCsv(
		[
			member({
				displayName: 'Alice',
				email: 'alice@example.com',
				targetSeconds: 40 * HOUR,
				totalSeconds: 36 * HOUR,
				onTimeStatus: 'on-time',
			}),
		],
		{
			provenance: { jiraHost: 'acme.atlassian.net' },
			period: '2026-03-02..2026-03-08',
		},
	);

	it('emits the completeness header and a data row', () => {
		const [header, firstRow] = csv.split('\n');
		expect(header).toBe(
			'Team Member;Email;Expected (h);Logged (h);Completeness (%);On-time',
		);
		expect(firstRow).toBe('Alice;alice@example.com;40.0;36.0;90;On time');
	});

	it('appends the provenance footer', () => {
		expect(csv).toContain('# generated=');
		expect(csv).toContain('jira=acme.atlassian.net');
		expect(csv).toContain('period=2026-03-02..2026-03-08');
	});

	it('can omit the provenance footer', () => {
		const bare = buildTeamCompletenessCsv([member({ displayName: 'B' })], {
			includeProvenance: false,
		});
		expect(bare).not.toContain('# generated=');
	});
});

describe('buildTeamCompletenessWorkbook (ADA-390)', () => {
	it('returns a real .xlsx (ZIP) byte stream', () => {
		const bytes = buildTeamCompletenessWorkbook([
			member({ displayName: 'Alice', targetSeconds: 40 * HOUR }),
		]);
		expect(bytes[0]).toBe(0x50); // 'P'
		expect(bytes[1]).toBe(0x4b); // 'K'
		expect(bytes.length).toBeGreaterThan(100);
	});
});
