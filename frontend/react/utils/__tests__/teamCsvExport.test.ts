import { describe, expect, it } from 'vitest';
import type { TeamMemberSummary } from '../../../services/teamService';
import { buildTeamCsv } from '../teamCsvExport';

const weekdays = [
	'2026-03-09',
	'2026-03-10',
	'2026-03-11',
	'2026-03-12',
	'2026-03-13',
];

const fixedProvenance = {
	jiraHost: 'example.atlassian.net',
	generatedAt: '2026-03-16T09:00:00.000Z',
	sourceVersion: '1.2.3',
};

function makeMember(
	overrides: Partial<TeamMemberSummary> = {},
): TeamMemberSummary {
	return {
		email: 'alice@example.com',
		displayName: 'Alice',
		dailyHours: new Map([
			['2026-03-09', 8],
			['2026-03-10', 7.5],
			['2026-03-11', 8],
			['2026-03-12', 8],
			['2026-03-13', 6],
		]),
		totalSeconds: 37.5 * 3600,
		targetSeconds: 40 * 3600,
		gapSeconds: 2.5 * 3600,
		backdatedSeconds: 0,
		backdatedCount: 0,
		...overrides,
	};
}

describe('buildTeamCsv', () => {
	it('adds Absence (h) column when includeAbsenceColumns is on', () => {
		// 5 weekdays × 8h = 40h baseline. Member's target is 32h → 8h absence.
		const m = makeMember({
			targetSeconds: 32 * 3600,
			totalSeconds: 32 * 3600,
			gapSeconds: 0,
		});
		const csv = buildTeamCsv([m], weekdays, {
			provenance: fixedProvenance,
			includeAbsenceColumns: true,
		});
		const headerLine = csv.split('\n')[0];
		expect(headerLine).toContain('Absence (h)');
		// Data row last field should be 8.0
		const memberLine = csv.split('\n')[1];
		const memberCells = memberLine.split(';');
		expect(memberCells[memberCells.length - 1]).toBe('8.0');
	});

	it('omits Absence (h) when toggle is off (legacy byte-stable behavior)', () => {
		const csv = buildTeamCsv([makeMember()], weekdays, {
			provenance: fixedProvenance,
		});
		expect(csv.split('\n')[0]).not.toContain('Absence (h)');
	});

	it('omits the provenance footer when includeProvenance is false', () => {
		const csv = buildTeamCsv([makeMember()], weekdays, {
			provenance: fixedProvenance,
			includeProvenance: false,
		});
		expect(csv).not.toContain('# generated=');
	});

	it('includes Backdated (h) column in the header', () => {
		const csv = buildTeamCsv([makeMember()], weekdays, fixedProvenance);
		const headerLine = csv.split('\n')[0];

		expect(headerLine).toContain('Backdated (h)');
		// The Backdated column sits between Total and Gap so the schema mirrors
		// the finance-grade per-user export.
		const fields = headerLine.split(';');
		const totalIdx = fields.indexOf('Total (h)');
		const backdatedIdx = fields.indexOf('Backdated (h)');
		const gapIdx = fields.indexOf('Gap (h)');
		expect(backdatedIdx).toBe(totalIdx + 1);
		expect(gapIdx).toBe(backdatedIdx + 1);
	});

	it('emits 0.0 in the Backdated column when no entries are backdated', () => {
		const csv = buildTeamCsv([makeMember()], weekdays, fixedProvenance);
		const lines = csv.split('\n');
		const memberRow = lines[1].split(';');
		expect(memberRow.at(-2)).toBe('0.0');
	});

	it('renders backdatedSeconds (in hours, 1dp) in the Backdated column', () => {
		const csv = buildTeamCsv(
			[makeMember({ backdatedSeconds: 8 * 3600, backdatedCount: 1 })],
			weekdays,
			fixedProvenance,
		);
		const memberRow = csv.split('\n')[1].split(';');
		expect(memberRow.at(-2)).toBe('8.0');
	});

	it('averages backdatedSeconds across the team for the Team Average row', () => {
		const csv = buildTeamCsv(
			[
				makeMember({ backdatedSeconds: 8 * 3600, backdatedCount: 1 }),
				makeMember({
					email: 'bob@example.com',
					displayName: 'Bob',
					backdatedSeconds: 4 * 3600,
					backdatedCount: 1,
				}),
			],
			weekdays,
			fixedProvenance,
		);
		const lines = csv.split('\n');
		const avgRow = lines[3].split(';'); // header, two members, avg, footer
		expect(avgRow[0]).toBe('Team Average');
		expect(avgRow.at(-2)).toBe('6.0'); // (8 + 4) / 2
	});

	it('appends a provenance footer line in the canonical format', () => {
		const csv = buildTeamCsv([makeMember()], weekdays, fixedProvenance);
		const lastLine = csv.split('\n').at(-1) ?? '';

		expect(lastLine).toBe(
			'# generated=2026-03-16T09:00:00.000Z jira=example.atlassian.net policy=logged period=2026-03-09..2026-03-13 version=1.2.3',
		);
	});

	it('keeps the matrix shape with one column per weekday', () => {
		const csv = buildTeamCsv([makeMember()], weekdays, fixedProvenance);
		const headerLine = csv.split('\n')[0];
		const fields = headerLine.split(';');
		// Team Member, Email, 5 weekdays, Total, Backdated, Gap = 10 columns
		expect(fields).toHaveLength(2 + weekdays.length + 3);
	});

	it('renders a Team Average row when at least one member is present', () => {
		const csv = buildTeamCsv(
			[
				makeMember(),
				makeMember({ email: 'bob@example.com', displayName: 'Bob' }),
			],
			weekdays,
			fixedProvenance,
		);
		const lines = csv.split('\n');
		// header, two member rows, average row, footer
		expect(lines).toHaveLength(5);
		expect(lines[3].startsWith('Team Average')).toBe(true);
	});

	it('defaults provenance metadata when not supplied', () => {
		const csv = buildTeamCsv([makeMember()], weekdays);
		const lastLine = csv.split('\n').at(-1) ?? '';

		expect(lastLine.startsWith('# generated=')).toBe(true);
		expect(lastLine).toContain('policy=logged');
		expect(lastLine).toContain('period=2026-03-09..2026-03-13');
	});

	it('keeps daily hours at 1dp precision', () => {
		const csv = buildTeamCsv([makeMember()], weekdays, fixedProvenance);
		const memberRow = csv.split('\n')[1].split(';');
		// First weekday cell after Email
		expect(memberRow[2]).toBe('8.0');
		expect(memberRow[3]).toBe('7.5');
	});
});
