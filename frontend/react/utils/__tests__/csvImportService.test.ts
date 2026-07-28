import { describe, expect, it } from 'vitest';
import {
	type ColumnMapping,
	detectPreset,
	extractIssueKey,
	mapRowsToDrafts,
	parseDate,
	parseDuration,
	secondsToJiraTime,
} from '../../../services/csvImportService';
import type { ParsedCsv } from '../csvImportParser';

// ─── parseDuration ────────────────────────────────────────────────────────

describe('parseDuration', () => {
	it('parses "1h 30m" format', () => {
		expect(parseDuration('1h 30m')).toBe(5400);
	});

	it('parses "2h" format', () => {
		expect(parseDuration('2h')).toBe(7200);
	});

	it('parses "45m" format', () => {
		expect(parseDuration('45m')).toBe(2700);
	});

	it('parses "1.5h" decimal hours', () => {
		expect(parseDuration('1.5h')).toBe(5400);
	});

	it('parses "01:30:00" H:M:S format', () => {
		expect(parseDuration('01:30:00')).toBe(5400);
	});

	it('parses "1:30" H:M format', () => {
		expect(parseDuration('1:30')).toBe(5400);
	});

	it('parses "1h30m" without space', () => {
		expect(parseDuration('1h30m')).toBe(5400);
	});

	it('parses bare seconds for large numbers', () => {
		expect(parseDuration('5400')).toBe(5400);
	});

	it('parses bare small integers as minutes', () => {
		expect(parseDuration('2')).toBe(120);
		expect(parseDuration('15')).toBe(900);
		expect(parseDuration('23')).toBe(1380);
	});

	it('parses small decimal numbers as hours', () => {
		expect(parseDuration('0.5')).toBe(1800);
	});

	it('returns 0 for empty string', () => {
		expect(parseDuration('')).toBe(0);
	});

	it('returns 0 for unparseable text', () => {
		expect(parseDuration('abc')).toBe(0);
	});

	it('handles "30min" format', () => {
		expect(parseDuration('30min')).toBe(1800);
	});

	it('handles "1h 15m 30s" full format', () => {
		expect(parseDuration('1h 15m 30s')).toBe(4530);
	});
});

// ─── secondsToJiraTime ────────────────────────────────────────────────────

describe('secondsToJiraTime', () => {
	it('converts 5400 seconds to "1h 30m"', () => {
		expect(secondsToJiraTime(5400)).toBe('1h 30m');
	});

	it('converts 7200 seconds to "2h"', () => {
		expect(secondsToJiraTime(7200)).toBe('2h');
	});

	it('converts 2700 seconds to "45m"', () => {
		expect(secondsToJiraTime(2700)).toBe('45m');
	});

	it('returns empty string for 0', () => {
		expect(secondsToJiraTime(0)).toBe('');
	});

	it('returns empty string for negative', () => {
		expect(secondsToJiraTime(-100)).toBe('');
	});
});

// ─── parseDate ────────────────────────────────────────────────────────────

describe('parseDate', () => {
	it('parses ISO format YYYY-MM-DD', () => {
		expect(parseDate('2024-03-15')).toBe('2024-03-15');
	});

	it('parses ISO format with time', () => {
		expect(parseDate('2024-03-15T10:30:00Z')).toBe('2024-03-15');
	});

	it('parses US format MM/DD/YYYY', () => {
		expect(parseDate('03/15/2024')).toBe('2024-03-15');
	});

	it('parses EU format DD/MM/YYYY when day > 12', () => {
		expect(parseDate('15/03/2024')).toBe('2024-03-15');
	});

	it('parses "Mar 15, 2024"', () => {
		expect(parseDate('Mar 15, 2024')).toBe('2024-03-15');
	});

	it('parses "15-Mar-2024"', () => {
		expect(parseDate('15-Mar-2024')).toBe('2024-03-15');
	});

	it('parses "15 March 2024"', () => {
		expect(parseDate('15 March 2024')).toBe('2024-03-15');
	});

	it('returns null for empty string', () => {
		expect(parseDate('')).toBeNull();
	});

	it('returns null for unparseable text', () => {
		expect(parseDate('not a date')).toBeNull();
	});

	it('handles single-digit month and day in ISO', () => {
		expect(parseDate('2024-3-5')).toBe('2024-03-05');
	});
});

// ─── extractIssueKey ──────────────────────────────────────────────────────

describe('extractIssueKey', () => {
	it('extracts a bare issue key', () => {
		expect(extractIssueKey('PROJ-123')).toBe('PROJ-123');
	});

	it('extracts an issue key from a description', () => {
		expect(extractIssueKey('Fixed PROJ-123 login bug')).toBe('PROJ-123');
	});

	it('uppercases the key', () => {
		expect(extractIssueKey('proj-123')).toBe('PROJ-123');
	});

	it('returns null when no key is found', () => {
		expect(extractIssueKey('Just a description')).toBeNull();
	});

	it('returns null for empty string', () => {
		expect(extractIssueKey('')).toBeNull();
	});

	it('extracts first key when multiple are present', () => {
		expect(extractIssueKey('PROJ-123 and PROJ-456')).toBe('PROJ-123');
	});
});

// ─── detectPreset ─────────────────────────────────────────────────────────

describe('detectPreset', () => {
	it('detects Toggl format', () => {
		const parsed: ParsedCsv = {
			headers: ['Description', 'Duration', 'Date', 'Project'],
			rows: [],
			delimiter: ',',
		};
		const result = detectPreset(parsed);
		expect(result.preset).toBe('toggl');
		expect(result.confidence).toBe('high');
		expect(result.mapping).not.toBeNull();
	});

	it('detects Clockify format', () => {
		const parsed: ParsedCsv = {
			headers: ['Project', 'Description', 'Date', 'Duration (h)'],
			rows: [],
			delimiter: ',',
		};
		const result = detectPreset(parsed);
		expect(result.preset).toBe('clockify');
		expect(result.confidence).toBe('high');
	});

	it('detects Harvest format', () => {
		const parsed: ParsedCsv = {
			headers: ['Date', 'Hours', 'Notes', 'Project'],
			rows: [],
			delimiter: ',',
		};
		const result = detectPreset(parsed);
		expect(result.preset).toBe('harvest');
		expect(result.confidence).toBe('high');
	});

	it('detects Tempo format', () => {
		const parsed: ParsedCsv = {
			headers: ['Date', 'Issue Key', 'Time Spent', 'Description'],
			rows: [],
			delimiter: ',',
		};
		const result = detectPreset(parsed);
		expect(result.preset).toBe('tempo');
		expect(result.confidence).toBe('high');
	});

	it('falls back to generic for unknown headers', () => {
		const parsed: ParsedCsv = {
			headers: ['Datum', 'Aufgabe', 'Dauer', 'Beschreibung'],
			rows: [],
			delimiter: ';',
		};
		const result = detectPreset(parsed);
		expect(result.preset).toBe('generic');
	});

	it('returns null mapping when no date/duration columns found', () => {
		const parsed: ParsedCsv = {
			headers: ['Foo', 'Bar', 'Baz'],
			rows: [],
			delimiter: ',',
		};
		const result = detectPreset(parsed);
		expect(result.mapping).toBeNull();
	});
});

// ─── mapRowsToDrafts ──────────────────────────────────────────────────────

describe('mapRowsToDrafts', () => {
	const mapping: ColumnMapping = {
		date: 2,
		issueKey: 0,
		duration: 1,
		description: 3,
	};

	it('maps valid rows to drafts', () => {
		const parsed: ParsedCsv = {
			headers: ['Issue', 'Duration', 'Date', 'Description'],
			rows: [
				['PROJ-123', '1h 30m', '2024-03-15', 'Fix login'],
				['PROJ-456', '45m', '2024-03-16', 'Add tests'],
			],
			delimiter: ',',
		};

		const result = mapRowsToDrafts(parsed, mapping);
		expect(result.drafts).toHaveLength(2);
		expect(result.skipped).toHaveLength(0);

		expect(result.drafts[0]).toEqual({
			issueKey: 'PROJ-123',
			timeSpent: '1h 30m',
			comment: 'Fix login',
			started: '2024-03-15',
		});
		expect(result.drafts[1]).toEqual({
			issueKey: 'PROJ-456',
			timeSpent: '45m',
			comment: 'Add tests',
			started: '2024-03-16',
		});
	});

	it('extracts issue keys from descriptions', () => {
		const parsed: ParsedCsv = {
			headers: ['Issue', 'Duration', 'Date', 'Description'],
			rows: [['', '1h', '2024-03-15', 'Fixed PROJ-123 login']],
			delimiter: ',',
		};

		const result = mapRowsToDrafts(parsed, mapping);
		expect(result.drafts).toHaveLength(1);
		expect(result.drafts[0].issueKey).toBe('PROJ-123');
	});

	it('skips rows with unparseable dates', () => {
		const parsed: ParsedCsv = {
			headers: ['Issue', 'Duration', 'Date', 'Description'],
			rows: [['PROJ-123', '1h', 'not-a-date', 'Fix login']],
			delimiter: ',',
		};

		const result = mapRowsToDrafts(parsed, mapping);
		expect(result.drafts).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].reason).toContain('Unparseable date');
	});

	it('skips rows with no issue key', () => {
		const parsed: ParsedCsv = {
			headers: ['Issue', 'Duration', 'Date', 'Description'],
			rows: [['no-key-here', '1h', '2024-03-15', 'Fix login']],
			delimiter: ',',
		};

		const result = mapRowsToDrafts(parsed, mapping);
		expect(result.drafts).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].reason).toContain('No Jira issue key');
	});

	it('skips rows with zero duration', () => {
		const parsed: ParsedCsv = {
			headers: ['Issue', 'Duration', 'Date', 'Description'],
			rows: [['PROJ-123', '0', '2024-03-15', 'Fix login']],
			delimiter: ',',
		};

		const result = mapRowsToDrafts(parsed, mapping);
		expect(result.drafts).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].reason).toContain('duration');
	});

	it('uses issue key as comment when description is empty', () => {
		const parsed: ParsedCsv = {
			headers: ['Issue', 'Duration', 'Date', 'Description'],
			rows: [['PROJ-123', '1h', '2024-03-15', '']],
			delimiter: ',',
		};

		const result = mapRowsToDrafts(parsed, mapping);
		expect(result.drafts[0].comment).toBe('PROJ-123');
	});

	it('handles a realistic Toggl export end-to-end', () => {
		const parsed: ParsedCsv = {
			headers: ['Description', 'Duration', 'Date', 'Project'],
			rows: [
				['PROJ-123 Fix login bug', '01:30:00', '2024-03-15', 'Backend'],
				['PROJ-456 Write unit tests', '00:45:00', '2024-03-15', 'Backend'],
				['PROJ-123 Review PR', '00:30:00', '2024-03-16', 'Backend'],
			],
			delimiter: ',',
		};

		const togglMapping: ColumnMapping = {
			date: 2,
			issueKey: 0,
			duration: 1,
			description: 0,
		};

		const result = mapRowsToDrafts(parsed, togglMapping);
		expect(result.drafts).toHaveLength(3);
		expect(result.skipped).toHaveLength(0);
		expect(result.drafts[0].timeSpent).toBe('1h 30m');
		expect(result.drafts[1].timeSpent).toBe('45m');
		expect(result.drafts[2].started).toBe('2024-03-16');
	});
});
