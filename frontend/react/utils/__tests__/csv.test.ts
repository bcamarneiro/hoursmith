import { describe, expect, it } from 'vitest';
import type { EnrichedJiraWorklog } from '../../../../types/jira';
import {
	buildSummaryCsv,
	buildTimesheetCsv,
	buildTimesheetFilename,
} from '../csv';
import { sanitizeFilename } from '../downloadFile';

const FROZEN_TIME = '2026-05-08T10:00:00.000Z';
const PROVENANCE = {
	jiraHost: 'mock.atlassian.net',
	sourceVersion: 'test',
	generatedAt: FROZEN_TIME,
};

const HEADER =
	'Name;TicketKey;TicketName;IntendedDate;LoggedDate;IsBackdated;BookedHours';

const mockIssue = {
	id: '12345',
	key: 'PROJ-123',
	fields: { summary: 'Test Issue' },
};
const author = {
	displayName: 'John Doe',
	emailAddress: 'john@example.com',
	accountId: 'acc123',
	active: true,
};

function entry(over: Partial<EnrichedJiraWorklog>): EnrichedJiraWorklog {
	return {
		id: '1',
		started: '2025-01-15T10:00:00.000Z',
		created: '2025-01-15T10:00:00.000Z',
		timeSpentSeconds: 7200,
		author,
		issue: mockIssue,
		...over,
	} as EnrichedJiraWorklog;
}

describe('buildTimesheetCsv', () => {
	it('emits header, three totals rows, and provenance for an empty input', () => {
		const result = buildTimesheetCsv({
			worklogs: [],
			issueSummaries: {},
			policy: 'logged',
			period: { year: 2025, month: 0 },
			provenance: PROVENANCE,
		});
		const lines = result.split('\n');
		expect(lines[0]).toBe(HEADER);
		expect(lines[1]).toBe(';;;;;Backdated;0.00');
		expect(lines[2]).toBe(';;;;;Non-backdated;0.00');
		expect(lines[3]).toBe(';;;;;Total;0.00');
		expect(lines[4]).toBe(
			'# generated=2026-05-08T10:00:00.000Z jira=mock.atlassian.net policy=logged period=2025-01 version=test',
		);
	});

	it('omits the provenance footer when includeProvenance is false', () => {
		const result = buildTimesheetCsv({
			worklogs: [],
			issueSummaries: {},
			policy: 'logged',
			period: { year: 2025, month: 0 },
			provenance: PROVENANCE,
			includeProvenance: false,
		});
		const lines = result.split('\n');
		expect(lines).toHaveLength(4); // header + 3 totals, no footer
		expect(result).not.toContain('# generated=');
	});

	it('emits a non-backdated row with both dates equal', () => {
		const result = buildTimesheetCsv({
			worklogs: [entry({ comment: 'Some work' })],
			issueSummaries: { '12345': 'Test Issue Summary' },
			policy: 'logged',
			period: { year: 2025, month: 0 },
			provenance: PROVENANCE,
		});
		const lines = result.split('\n');
		expect(lines[1]).toBe(
			'John Doe;PROJ-123;Test Issue Summary;2025-01-15;2025-01-15;false;2.00',
		);
	});

	it('classifies and surfaces a Pattern A (comment-marker) backdate', () => {
		const result = buildTimesheetCsv({
			worklogs: [
				entry({
					started: '2025-02-05T10:00:00.000Z',
					created: '2025-02-05T10:00:00.000Z',
					timeSpentSeconds: 3600,
					comment: 'Original Worklog Date was: 2025/01/20',
				}),
			],
			issueSummaries: { '12345': 'Test Issue' },
			policy: 'logged',
			period: { year: 2025, month: 1 },
			provenance: PROVENANCE,
		});
		const lines = result.split('\n');
		expect(lines[1]).toBe(
			'John Doe;PROJ-123;Test Issue;2025-01-20;2025-02-05;true;1.00',
		);
	});

	it('classifies a Pattern B (jira-native) backdate', () => {
		const result = buildTimesheetCsv({
			worklogs: [
				entry({
					started: '2025-09-28T10:00:00.000Z',
					created: '2025-10-02T10:00:00.000Z',
					timeSpentSeconds: 28800,
					comment: '',
				}),
			],
			issueSummaries: {},
			policy: 'logged',
			period: { year: 2025, month: 9 },
			provenance: PROVENANCE,
		});
		const lines = result.split('\n');
		expect(lines[1]).toBe(
			'John Doe;PROJ-123;Test Issue;2025-09-28;2025-10-02;true;8.00',
		);
	});

	it('policy=logged keeps a backdate in the logged month, drops it from the intended month', () => {
		const w = entry({
			started: '2025-09-28T10:00:00.000Z',
			created: '2025-10-02T10:00:00.000Z',
			timeSpentSeconds: 28800,
			comment: '',
		});

		const loggedMonth = buildTimesheetCsv({
			worklogs: [w],
			issueSummaries: {},
			policy: 'logged',
			period: { year: 2025, month: 9 },
			provenance: PROVENANCE,
		}).split('\n');
		const intendedMonth = buildTimesheetCsv({
			worklogs: [w],
			issueSummaries: {},
			policy: 'logged',
			period: { year: 2025, month: 8 },
			provenance: PROVENANCE,
		}).split('\n');

		// header + 1 data row + 3 total rows + provenance
		expect(loggedMonth).toHaveLength(6);
		// header + 3 total rows + provenance (no data rows)
		expect(intendedMonth).toHaveLength(5);
	});

	it('policy=intended places the backdate in the intended month instead', () => {
		const w = entry({
			started: '2025-09-28T10:00:00.000Z',
			created: '2025-10-02T10:00:00.000Z',
			timeSpentSeconds: 28800,
			comment: '',
		});

		const intendedMonth = buildTimesheetCsv({
			worklogs: [w],
			issueSummaries: {},
			policy: 'intended',
			period: { year: 2025, month: 8 },
			provenance: PROVENANCE,
		}).split('\n');
		const loggedMonth = buildTimesheetCsv({
			worklogs: [w],
			issueSummaries: {},
			policy: 'intended',
			period: { year: 2025, month: 9 },
			provenance: PROVENANCE,
		}).split('\n');

		expect(intendedMonth).toHaveLength(6);
		expect(loggedMonth).toHaveLength(5);
	});

	it('emits Backdated, Non-backdated, and Total subtotals that reconcile to filtered rows', () => {
		const result = buildTimesheetCsv({
			worklogs: [
				entry({
					id: '1',
					started: '2025-10-02T10:00:00.000Z',
					created: '2025-10-02T10:00:00.000Z',
					timeSpentSeconds: 14400, // 4h regular
					comment: '',
				}),
				entry({
					id: '2',
					started: '2025-09-28T10:00:00.000Z',
					created: '2025-10-02T10:00:00.000Z',
					timeSpentSeconds: 28800, // 8h backdated
					comment: '',
				}),
			],
			issueSummaries: {},
			policy: 'logged',
			period: { year: 2025, month: 9 },
			provenance: PROVENANCE,
		}).split('\n');

		expect(result.find((l) => l.startsWith(';;;;;Backdated;'))).toBe(
			';;;;;Backdated;8.00',
		);
		expect(result.find((l) => l.startsWith(';;;;;Non-backdated;'))).toBe(
			';;;;;Non-backdated;4.00',
		);
		expect(result.find((l) => l.startsWith(';;;;;Total;'))).toBe(
			';;;;;Total;12.00',
		);
	});

	it('escapes special characters in names and ticket summaries', () => {
		const result = buildTimesheetCsv({
			worklogs: [
				entry({
					timeSpentSeconds: 1800,
					author: { ...author, displayName: 'Jane, Doe' },
				}),
			],
			issueSummaries: { '12345': 'Issue with "quotes" and, commas' },
			policy: 'logged',
			period: { year: 2025, month: 0 },
			provenance: PROVENANCE,
		}).split('\n');

		expect(result[1]).toBe(
			'"Jane, Doe";PROJ-123;"Issue with ""quotes"" and, commas";2025-01-15;2025-01-15;false;0.50',
		);
	});

	it('neutralises formula injection in the ticket key cell (ADA-460)', () => {
		const result = buildTimesheetCsv({
			worklogs: [
				entry({
					issue: { ...mockIssue, key: '=HYPERLINK("evil")' },
				}),
			],
			issueSummaries: {},
			policy: 'logged',
			period: { year: 2025, month: 0 },
			provenance: PROVENANCE,
		}).split('\n');

		// Leading `=` neutralised with `'`; the `(`,`"` force CSV quoting.
		expect(result[1]).toContain(`"'=HYPERLINK(""evil"")"`);
	});

	it('uses ISO dates only', () => {
		const result = buildTimesheetCsv({
			worklogs: [entry({})],
			issueSummaries: {},
			policy: 'logged',
			period: { year: 2025, month: 0 },
			provenance: PROVENANCE,
		});
		expect(result).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);
	});

	it('sorts deterministically: primary date, secondary date, ticket key, id', () => {
		const result = buildTimesheetCsv({
			worklogs: [
				entry({
					id: '3',
					started: '2025-01-16T14:00:00.000Z',
					created: '2025-01-16T14:00:00.000Z',
					issue: { ...mockIssue, id: '12346', key: 'PROJ-124' },
				}),
				entry({
					id: '1',
					started: '2025-01-15T14:00:00.000Z',
					created: '2025-01-15T14:00:00.000Z',
					timeSpentSeconds: 1800,
					issue: { ...mockIssue, id: '12347', key: 'PROJ-125' },
				}),
				entry({
					id: '2',
					started: '2025-01-15T09:00:00.000Z',
					created: '2025-01-15T09:00:00.000Z',
					timeSpentSeconds: 3600,
					comment: 'Original Worklog Date was: 2025/01/10',
				}),
			],
			issueSummaries: {
				'12345': 'First',
				'12346': 'Second',
				'12347': 'Third',
			},
			policy: 'logged',
			period: { year: 2025, month: 0 },
			provenance: PROVENANCE,
		}).split('\n');

		expect(result[1]).toContain('PROJ-123;First;2025-01-10;2025-01-15');
		expect(result[2]).toContain('PROJ-125;Third;2025-01-15;2025-01-15');
		expect(result[3]).toContain('PROJ-124;Second;2025-01-16;2025-01-16');
	});
});

describe('buildTimesheetCsv: includeAbsenceColumns', () => {
	const absenceDays = new Map([
		[
			'2025-01-15',
			{
				date: '2025-01-15',
				reasons: ['Vacation - Bruno'],
				kind: 'vacation' as const,
			},
		],
		[
			'2025-01-16',
			{
				date: '2025-01-16',
				reasons: ['Labour Day'],
				kind: 'holiday' as const,
			},
		],
	]);

	it('adds IsAbsence/AbsenceKind columns and an AbsenceDays subtotal when enabled', () => {
		const result = buildTimesheetCsv({
			worklogs: [entry({ comment: 'Some work' })],
			issueSummaries: { '12345': 'Test Issue Summary' },
			policy: 'logged',
			period: { year: 2025, month: 0 },
			provenance: PROVENANCE,
			absenceDays,
			includeAbsenceColumns: true,
		});
		const lines = result.split('\n');
		expect(lines[0]).toBe(
			'Name;TicketKey;TicketName;IntendedDate;LoggedDate;IsBackdated;BookedHours;IsAbsence;AbsenceKind',
		);
		expect(lines[1]).toBe(
			'John Doe;PROJ-123;Test Issue Summary;2025-01-15;2025-01-15;false;2.00;true;Vacation',
		);
		// AbsenceDays subtotal counts dates that fall inside Jan 2025 only.
		expect(result).toContain(';;;;;;;AbsenceDays;2');
	});

	it('omits absence columns entirely when toggle is off (byte-identical to legacy)', () => {
		const withFlagOff = buildTimesheetCsv({
			worklogs: [entry({ comment: 'Some work' })],
			issueSummaries: { '12345': 'Test Issue Summary' },
			policy: 'logged',
			period: { year: 2025, month: 0 },
			provenance: PROVENANCE,
			absenceDays,
			includeAbsenceColumns: false,
		});
		const noAbsenceProvided = buildTimesheetCsv({
			worklogs: [entry({ comment: 'Some work' })],
			issueSummaries: { '12345': 'Test Issue Summary' },
			policy: 'logged',
			period: { year: 2025, month: 0 },
			provenance: PROVENANCE,
		});
		expect(withFlagOff).toBe(noAbsenceProvided);
	});
});

describe('buildSummaryCsv', () => {
	it('lists per-user totals plus backdated columns and a provenance footer', () => {
		const result = buildSummaryCsv({
			summaries: [
				{
					user: 'Alice',
					totalHours: 160,
					backdatedHours: 8,
					worklogCount: 22,
					backdatedCount: 1,
					daysWorked: 20,
				},
			],
			policy: 'logged',
			period: { year: 2025, month: 9 },
			provenance: PROVENANCE,
		});

		expect(result).toContain(
			'User;DaysWorked;Entries;BackdatedEntries;TotalHours;BackdatedHours',
		);
		expect(result).toContain('Alice;20.0;22;1;160.00;8.00');
		expect(result).toMatch(/policy=logged/);
		expect(result).toMatch(/period=2025-10/);
	});

	it('omits the provenance footer when includeProvenance is false', () => {
		const result = buildSummaryCsv({
			summaries: [
				{
					user: 'Alice',
					totalHours: 160,
					backdatedHours: 8,
					worklogCount: 22,
					backdatedCount: 1,
					daysWorked: 20,
				},
			],
			policy: 'logged',
			period: { year: 2025, month: 9 },
			provenance: PROVENANCE,
			includeProvenance: false,
		});
		expect(result).not.toContain('# generated=');
	});
});

describe('buildTimesheetFilename', () => {
	it('encodes user, period, and policy', () => {
		expect(
			buildTimesheetFilename('Sarah Johnson', 'logged', {
				year: 2025,
				month: 9,
			}),
		).toBe('timesheet_Sarah-Johnson_2025-10_logged.csv');
	});
});

describe('sanitizeFilename', () => {
	it('replaces unsafe filename characters', () => {
		expect(sanitizeFilename('Sarah / QA: Sprint 1.csv')).toBe(
			'Sarah-QA-Sprint-1.csv',
		);
	});
});
