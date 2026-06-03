import { describe, expect, it } from 'vitest';
import type { WeekWorklogEntry } from '../../../stores/useDashboardStore';
import { generateWeeklyCsv } from '../weekCsvExport';

describe('generateWeeklyCsv', () => {
	const weekStart = '2026-03-09';
	const weekEnd = '2026-03-15';
	const fixedProvenance = {
		jiraHost: 'example.atlassian.net',
		generatedAt: '2026-03-16T09:00:00.000Z',
		sourceVersion: '1.2.3',
	};

	it('should generate CSV with correct headers and three total rows when no worklogs', () => {
		const result = generateWeeklyCsv(weekStart, weekEnd, [], fixedProvenance);
		const lines = result.split('\n');

		expect(lines).toHaveLength(6);
		expect(lines[0]).toBe(`Week Range;${weekStart} to ${weekEnd}`);
		expect(lines[1]).toBe(
			'Date;Day;Issue Key;Issue Summary;Time Spent (hours);Time Spent (formatted);IsBackdated',
		);
		expect(lines[2]).toBe('Backdated;;;;0.00;0h;');
		expect(lines[3]).toBe('Non-backdated;;;;0.00;0h;');
		expect(lines[4]).toBe('Week Total;;;;0.00;0h;');
		expect(lines[5]).toBe(
			'# generated=2026-03-16T09:00:00.000Z jira=example.atlassian.net policy=logged period=2026-03-09..2026-03-15 version=1.2.3',
		);
	});

	it('omits the provenance footer when includeProvenance is false', () => {
		const result = generateWeeklyCsv(weekStart, weekEnd, [], {
			provenance: fixedProvenance,
			includeProvenance: false,
		});
		const lines = result.split('\n');
		expect(lines).toHaveLength(5); // meta + header + 3 totals, no footer
		expect(result).not.toContain('# generated=');
	});

	it('should export a single worklog correctly', () => {
		const worklogs: WeekWorklogEntry[] = [
			{
				date: '2026-03-10',
				issueKey: 'PROJ-100',
				issueSummary: 'Implement feature',
				timeSpentSeconds: 7200,
			},
		];

		const result = generateWeeklyCsv(
			weekStart,
			weekEnd,
			worklogs,
			fixedProvenance,
		);
		const lines = result.split('\n');

		// header meta + header + 1 row + 3 totals + provenance = 7
		expect(lines).toHaveLength(7);
		expect(lines[2]).toBe(
			'2026-03-10;Tue;PROJ-100;Implement feature;2.00;2h;false',
		);
		expect(lines[3]).toBe('Backdated;;;;0.00;0h;');
		expect(lines[4]).toBe('Non-backdated;;;;2.00;2h;');
		expect(lines[5]).toBe('Week Total;;;;2.00;2h;');
	});

	it('should sort by date then issue key', () => {
		const worklogs: WeekWorklogEntry[] = [
			{
				date: '2026-03-11',
				issueKey: 'PROJ-200',
				issueSummary: 'Second issue',
				timeSpentSeconds: 3600,
			},
			{
				date: '2026-03-10',
				issueKey: 'PROJ-100',
				issueSummary: 'First issue',
				timeSpentSeconds: 7200,
			},
			{
				date: '2026-03-10',
				issueKey: 'PROJ-050',
				issueSummary: 'Earlier key same day',
				timeSpentSeconds: 1800,
			},
		];

		const result = generateWeeklyCsv(
			weekStart,
			weekEnd,
			worklogs,
			fixedProvenance,
		);
		const lines = result.split('\n');

		// meta + header + 3 rows + 3 totals + provenance = 9
		expect(lines).toHaveLength(9);
		expect(lines[2]).toContain('PROJ-050');
		expect(lines[3]).toContain('PROJ-100');
		expect(lines[4]).toContain('PROJ-200');
	});

	it('should handle CSV special characters in summaries', () => {
		const worklogs: WeekWorklogEntry[] = [
			{
				date: '2026-03-10',
				issueKey: 'PROJ-100',
				issueSummary: 'Fix "bug" with; separator, and commas',
				timeSpentSeconds: 3600,
			},
		];

		const result = generateWeeklyCsv(
			weekStart,
			weekEnd,
			worklogs,
			fixedProvenance,
		);
		const lines = result.split('\n');

		expect(lines[2]).toBe(
			'2026-03-10;Tue;PROJ-100;"Fix ""bug"" with; separator, and commas";1.00;1h;false',
		);
	});

	it('should handle missing issue summary', () => {
		const worklogs: WeekWorklogEntry[] = [
			{
				date: '2026-03-10',
				issueKey: 'PROJ-100',
				timeSpentSeconds: 5400,
			},
		];

		const result = generateWeeklyCsv(
			weekStart,
			weekEnd,
			worklogs,
			fixedProvenance,
		);
		const lines = result.split('\n');

		expect(lines[2]).toBe('2026-03-10;Tue;PROJ-100;;1.50;1h 30m;false');
	});

	it('should format time correctly', () => {
		const testCases = [
			{ seconds: 3600, hours: '1.00', formatted: '1h' },
			{ seconds: 1800, hours: '0.50', formatted: '30m' },
			{ seconds: 5400, hours: '1.50', formatted: '1h 30m' },
			{ seconds: 28800, hours: '8.00', formatted: '8h' },
		];

		for (const tc of testCases) {
			const worklogs: WeekWorklogEntry[] = [
				{
					date: '2026-03-10',
					issueKey: 'PROJ-100',
					issueSummary: 'Test',
					timeSpentSeconds: tc.seconds,
				},
			];

			const result = generateWeeklyCsv(
				weekStart,
				weekEnd,
				worklogs,
				fixedProvenance,
			);
			const lines = result.split('\n');
			const fields = lines[2].split(';');

			expect(fields[4]).toBe(tc.hours);
			expect(fields[5]).toBe(tc.formatted);
		}
	});

	it('should use semicolon as delimiter with seven columns', () => {
		const worklogs: WeekWorklogEntry[] = [
			{
				date: '2026-03-10',
				issueKey: 'PROJ-100',
				issueSummary: 'Test',
				timeSpentSeconds: 3600,
			},
		];

		const result = generateWeeklyCsv(
			weekStart,
			weekEnd,
			worklogs,
			fixedProvenance,
		);
		const headerLine = result.split('\n')[1];
		const semicolonCount = (headerLine.match(/;/g) || []).length;

		expect(semicolonCount).toBe(6); // 7 columns = 6 semicolons
	});

	it('emits Backdated / Non-backdated / Week Total above the provenance line', () => {
		const result = generateWeeklyCsv(
			weekStart,
			weekEnd,
			[
				{
					date: '2026-03-10',
					issueKey: 'PROJ-100',
					issueSummary: 'Test',
					timeSpentSeconds: 5400, // 1.5h regular
				},
				{
					date: '2026-03-11',
					issueKey: 'PROJ-200',
					issueSummary: 'Backdated entry',
					timeSpentSeconds: 1800, // 0.5h backdated
					comment: 'Original Worklog Date was: 2026/02/01',
				},
			],
			fixedProvenance,
		);

		const lines = result.split('\n');
		expect(lines.at(-4)).toBe('Backdated;;;;0.50;30m;');
		expect(lines.at(-3)).toBe('Non-backdated;;;;1.50;1h 30m;');
		expect(lines.at(-2)).toBe('Week Total;;;;2.00;2h;');
		expect(lines.at(-1)).toBe(
			'# generated=2026-03-16T09:00:00.000Z jira=example.atlassian.net policy=logged period=2026-03-09..2026-03-15 version=1.2.3',
		);
	});

	it('should mark backdated entries when created month differs from started date', () => {
		const worklogs: WeekWorklogEntry[] = [
			{
				date: '2026-03-10',
				issueKey: 'PROJ-100',
				issueSummary: 'Logged a month later',
				timeSpentSeconds: 3600,
				created: '2026-04-15T08:00:00.000Z',
			},
		];

		const result = generateWeeklyCsv(
			weekStart,
			weekEnd,
			worklogs,
			fixedProvenance,
		);
		const lines = result.split('\n');
		const fields = lines[2].split(';');

		expect(fields[6]).toBe('true');
	});

	it('should mark backdated entries flagged via comment marker', () => {
		const worklogs: WeekWorklogEntry[] = [
			{
				date: '2026-03-10',
				issueKey: 'PROJ-100',
				issueSummary: 'Same month but flagged',
				timeSpentSeconds: 3600,
				created: '2026-03-10T17:00:00.000Z',
				comment: 'Original Worklog Date was: 2026/03/03',
			},
		];

		const result = generateWeeklyCsv(
			weekStart,
			weekEnd,
			worklogs,
			fixedProvenance,
		);
		const fields = result.split('\n')[2].split(';');

		expect(fields[6]).toBe('true');
	});

	it('adds IsAbsence/AbsenceKind columns and an Absence Days subtotal when enabled', () => {
		const worklogs: WeekWorklogEntry[] = [
			{
				date: '2026-03-10',
				issueKey: 'PROJ-100',
				issueSummary: 'Worked through PTO',
				timeSpentSeconds: 14400,
			},
		];
		const absenceDays = new Map([
			[
				'2026-03-10',
				{
					date: '2026-03-10',
					reasons: ['Vacation'],
					kind: 'vacation' as const,
				},
			],
		]);
		const result = generateWeeklyCsv(weekStart, weekEnd, worklogs, {
			provenance: fixedProvenance,
			absenceDays,
			includeAbsenceColumns: true,
		});
		const lines = result.split('\n');
		expect(lines[1]).toBe(
			'Date;Day;Issue Key;Issue Summary;Time Spent (hours);Time Spent (formatted);IsBackdated;IsAbsence;AbsenceKind',
		);
		// Row carries true + 'Vacation' for the absence column pair.
		expect(lines[2]).toContain(';true;Vacation');
		// Absence Days subtotal counts dates in range.
		expect(result).toContain('Absence Days;;;;1');
	});

	it('legacy single-arg call (bare provenance) preserves byte-stable output', () => {
		const worklogs: WeekWorklogEntry[] = [
			{
				date: '2026-03-10',
				issueKey: 'PROJ-100',
				issueSummary: 'Test',
				timeSpentSeconds: 3600,
			},
		];
		const withOptions = generateWeeklyCsv(weekStart, weekEnd, worklogs, {
			provenance: fixedProvenance,
		});
		const withLegacy = generateWeeklyCsv(
			weekStart,
			weekEnd,
			worklogs,
			fixedProvenance,
		);
		expect(withOptions).toBe(withLegacy);
	});

	it('should default provenance metadata when not supplied', () => {
		const result = generateWeeklyCsv(weekStart, weekEnd, []);
		const last = result.split('\n').at(-1) ?? '';

		expect(last.startsWith('# generated=')).toBe(true);
		expect(last).toContain('policy=logged');
		expect(last).toContain(`period=${weekStart}..${weekEnd}`);
	});
});
