/**
 * Minimal, dependency-free `.xlsx` writer (ADA-390).
 *
 * Managers live in Excel, and a double-clicked `.csv` can mangle columns or
 * locale. The repo intentionally ships no spreadsheet library, so this produces
 * a real single-sheet OOXML workbook by hand: a ZIP (STORE / no compression, so
 * no DEFLATE dependency) of the five parts Excel needs, with inline strings so
 * there is no shared-string table to maintain.
 *
 * Scope is deliberately tiny: one sheet, string/number cells, no styling. That
 * is all the completeness export needs; anything richer should reach for a real
 * library instead of growing this.
 */

export type XlsxCell = string | number;
export type XlsxRow = XlsxCell[];

// --- CRC32 (ZIP requires a CRC32 per entry) ---

const CRC_TABLE: number[] = (() => {
	const table: number[] = new Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

// --- helpers ---

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/** 0-based column index → spreadsheet letters (0→A, 25→Z, 26→AA). */
export function columnLetter(index: number): string {
	let n = index;
	let letters = '';
	do {
		letters = String.fromCharCode(65 + (n % 26)) + letters;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return letters;
}

const encoder = new TextEncoder();

function buildSheetXml(rows: XlsxRow[]): string {
	const rowsXml = rows
		.map((row, rowIndex) => {
			const rowNumber = rowIndex + 1;
			const cells = row
				.map((cell, colIndex) => {
					const ref = `${columnLetter(colIndex)}${rowNumber}`;
					if (typeof cell === 'number' && Number.isFinite(cell)) {
						return `<c r="${ref}"><v>${cell}</v></c>`;
					}
					const text = xmlEscape(String(cell));
					return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
				})
				.join('');
			return `<row r="${rowNumber}">${cells}</row>`;
		})
		.join('');
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
}

interface ZipEntry {
	name: string;
	data: Uint8Array;
}

// Concatenate byte chunks into one Uint8Array.
function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, c) => sum + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function u16(value: number): Uint8Array {
	return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
	return new Uint8Array([
		value & 0xff,
		(value >>> 8) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 24) & 0xff,
	]);
}

/** Build a ZIP archive from entries using the STORE (uncompressed) method. */
function buildZip(entries: ZipEntry[]): Uint8Array {
	const localChunks: Uint8Array[] = [];
	const centralChunks: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name);
		const crc = crc32(entry.data);
		const size = entry.data.length;

		// Local file header (signature 0x04034b50), STORE method, no date/time.
		const localHeader = concatBytes([
			u32(0x04034b50),
			u16(20), // version needed
			u16(0), // flags
			u16(0), // method: 0 = store
			u16(0), // mod time
			u16(0), // mod date
			u32(crc),
			u32(size), // compressed size
			u32(size), // uncompressed size
			u16(nameBytes.length),
			u16(0), // extra length
			nameBytes,
		]);
		localChunks.push(localHeader, entry.data);

		// Central directory header (signature 0x02014b50).
		centralChunks.push(
			concatBytes([
				u32(0x02014b50),
				u16(20), // version made by
				u16(20), // version needed
				u16(0), // flags
				u16(0), // method
				u16(0), // mod time
				u16(0), // mod date
				u32(crc),
				u32(size),
				u32(size),
				u16(nameBytes.length),
				u16(0), // extra length
				u16(0), // comment length
				u16(0), // disk number start
				u16(0), // internal attrs
				u32(0), // external attrs
				u32(offset), // local header offset
				nameBytes,
			]),
		);

		offset += localHeader.length + entry.data.length;
	}

	const centralDir = concatBytes(centralChunks);
	const centralSize = centralDir.length;
	const centralOffset = offset;

	// End of central directory record (signature 0x06054b50).
	const eocd = concatBytes([
		u32(0x06054b50),
		u16(0), // disk number
		u16(0), // disk with central dir
		u16(entries.length), // entries on this disk
		u16(entries.length), // total entries
		u32(centralSize),
		u32(centralOffset),
		u16(0), // comment length
	]);

	return concatBytes([...localChunks, centralDir, eocd]);
}

/**
 * Build a single-sheet `.xlsx` workbook from a 2-D array of cells.
 * The first row is typically the header. Returns the raw file bytes.
 */
export function buildXlsx(sheetName: string, rows: XlsxRow[]): Uint8Array {
	// Excel caps sheet names at 31 chars and forbids a handful of characters.
	const safeSheetName =
		xmlEscape(sheetName.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31)) || 'Sheet1';

	const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

	const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

	const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

	const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

	const entries: ZipEntry[] = [
		{ name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
		{ name: '_rels/.rels', data: encoder.encode(rootRels) },
		{ name: 'xl/workbook.xml', data: encoder.encode(workbook) },
		{ name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
		{
			name: 'xl/worksheets/sheet1.xml',
			data: encoder.encode(buildSheetXml(rows)),
		},
	];

	return buildZip(entries);
}
