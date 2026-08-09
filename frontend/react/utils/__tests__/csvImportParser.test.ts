import { describe, expect, it } from 'vitest';
import { parseCsv } from '../csvImportParser';

describe('parseCsv', () => {
	it('parses a simple comma-delimited CSV', () => {
		const csv = 'Name,Age,City\nAlice,30,Lisbon\nBob,25,Porto';
		const result = parseCsv(csv);

		expect(result.headers).toEqual(['Name', 'Age', 'City']);
		expect(result.rows).toEqual([
			['Alice', '30', 'Lisbon'],
			['Bob', '25', 'Porto'],
		]);
		expect(result.delimiter).toBe(',');
	});

	it('auto-detects semicolon delimiter', () => {
		const csv = 'Name;Age;City\nAlice;30;Lisbon\nBob;25;Porto';
		const result = parseCsv(csv);

		expect(result.headers).toEqual(['Name', 'Age', 'City']);
		expect(result.rows).toEqual([
			['Alice', '30', 'Lisbon'],
			['Bob', '25', 'Porto'],
		]);
		expect(result.delimiter).toBe(';');
	});

	it('handles quoted fields with embedded commas', () => {
		const csv = 'Name,Description\nAlice,"Fixed PROJ-123, added tests"\nBob,"Simple fix"';
		const result = parseCsv(csv);

		expect(result.headers).toEqual(['Name', 'Description']);
		expect(result.rows).toEqual([
			['Alice', 'Fixed PROJ-123, added tests'],
			['Bob', 'Simple fix'],
		]);
	});

	it('handles escaped quotes inside quoted fields', () => {
		const csv = 'Name,Note\nAlice,"She said ""hello"""\nBob,"Normal"';
		const result = parseCsv(csv);

		expect(result.rows[0][1]).toBe('She said "hello"');
		expect(result.rows[1][1]).toBe('Normal');
	});

	it('strips UTF-8 BOM', () => {
		const csv = '\uFEFFName,Age\nAlice,30';
		const result = parseCsv(csv);

		expect(result.headers).toEqual(['Name', 'Age']);
		expect(result.rows).toEqual([['Alice', '30']]);
	});

	it('skips blank rows', () => {
		const csv = 'Name,Age\nAlice,30\n\nBob,25\n';
		const result = parseCsv(csv);

		expect(result.rows).toEqual([
			['Alice', '30'],
			['Bob', '25'],
		]);
	});

	it('pads short rows to match header length', () => {
		const csv = 'A,B,C\n1,2\n3,4,5';
		const result = parseCsv(csv);

		expect(result.rows[0]).toEqual(['1', '2', '']);
		expect(result.rows[1]).toEqual(['3', '4', '5']);
	});

	it('truncates long rows to match header length', () => {
		const csv = 'A,B\n1,2,3,4';
		const result = parseCsv(csv);

		expect(result.rows[0]).toEqual(['1', '2']);
	});

	it('trims whitespace from field values', () => {
		const csv = 'Name , Age \n Alice , 30 ';
		const result = parseCsv(csv);

		expect(result.headers).toEqual(['Name', 'Age']);
		expect(result.rows).toEqual([['Alice', '30']]);
	});

	it('throws on empty input', () => {
		expect(() => parseCsv('')).toThrow('CSV file is empty');
	});

	it('throws on whitespace-only input', () => {
		expect(() => parseCsv('   \n  \n  ')).toThrow('CSV file is empty');
	});

	it('handles quoted fields with embedded newlines', () => {
		const csv = 'Name,Description\nAlice,"Line 1\nLine 2"\nBob,Simple';
		const result = parseCsv(csv);

		expect(result.headers).toEqual(['Name', 'Description']);
		expect(result.rows).toEqual([
			['Alice', 'Line 1\nLine 2'],
			['Bob', 'Simple'],
		]);
	});

	it('handles \\r\\n line endings', () => {
		const csv = 'Name,Age\r\nAlice,30\r\nBob,25';
		const result = parseCsv(csv);

		expect(result.rows).toEqual([
			['Alice', '30'],
			['Bob', '25'],
		]);
	});

	it('handles a Toggl-like CSV export', () => {
		const csv = [
			'Description,Duration,Date,Project',
			'"PROJ-123 Fix login",01:30:00,2024-03-15,MyProject',
			'"PROJ-456 Add tests",00:45:00,2024-03-15,MyProject',
		].join('\n');
		const result = parseCsv(csv);

		expect(result.headers).toEqual(['Description', 'Duration', 'Date', 'Project']);
		expect(result.rows).toHaveLength(2);
		expect(result.rows[0]).toEqual([
			'PROJ-123 Fix login',
			'01:30:00',
			'2024-03-15',
			'MyProject',
		]);
	});

	it('handles a semicolon-delimited European CSV', () => {
		const csv = [
			'Datum;Aufgabe;Dauer;Beschreibung',
			'15.03.2024;PROJ-123;1h 30m;Login fixen',
		].join('\n');
		const result = parseCsv(csv);

		expect(result.delimiter).toBe(';');
		expect(result.headers).toEqual(['Datum', 'Aufgabe', 'Dauer', 'Beschreibung']);
		expect(result.rows).toHaveLength(1);
	});
});
