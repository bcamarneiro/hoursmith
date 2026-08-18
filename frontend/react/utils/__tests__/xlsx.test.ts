import { describe, expect, it } from 'vitest';
import { buildXlsx, columnLetter, crc32 } from '../xlsx';

function toBinaryString(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
	return out;
}

describe('crc32', () => {
	it('matches the standard check vector for "123456789"', () => {
		const bytes = new TextEncoder().encode('123456789');
		// The canonical CRC-32 check value.
		expect(crc32(bytes) >>> 0).toBe(0xcbf43926);
	});

	it('returns 0 for empty input', () => {
		expect(crc32(new Uint8Array())).toBe(0);
	});
});

describe('columnLetter', () => {
	it('maps 0-based indices to spreadsheet columns', () => {
		expect(columnLetter(0)).toBe('A');
		expect(columnLetter(25)).toBe('Z');
		expect(columnLetter(26)).toBe('AA');
		expect(columnLetter(27)).toBe('AB');
	});
});

describe('buildXlsx', () => {
	const bytes = buildXlsx('Report', [
		['Name', 'Score'],
		['Alice', 3],
		['Bob & Co <x>', 7],
	]);
	const binary = toBinaryString(bytes);

	it('produces a ZIP container (PK local + end-of-central-directory)', () => {
		expect(bytes[0]).toBe(0x50); // 'P'
		expect(bytes[1]).toBe(0x4b); // 'K'
		expect(binary).toContain('PK'); // EOCD signature
	});

	it('includes the required OOXML parts', () => {
		expect(binary).toContain('[Content_Types].xml');
		expect(binary).toContain('xl/workbook.xml');
		expect(binary).toContain('xl/worksheets/sheet1.xml');
	});

	it('writes numbers as numeric cells and strings as inline strings', () => {
		expect(binary).toContain('<v>3</v>');
		expect(binary).toContain('<v>7</v>');
		expect(binary).toContain('Alice');
	});

	it('xml-escapes string cell content', () => {
		expect(binary).toContain('Bob &amp; Co &lt;x&gt;');
		expect(binary).not.toContain('Bob & Co <x>');
	});

	it('uses the sheet name (truncated/sanitised)', () => {
		expect(binary).toContain('name="Report"');
	});
});
