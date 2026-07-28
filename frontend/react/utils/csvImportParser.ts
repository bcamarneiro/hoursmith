/**
 * Client-side CSV parser for the worklog importer.
 *
 * Handles the common quirks of CSV exports from Toggl, Clockify, Harvest,
 * Tempo, and generic time-tracking tools:
 *
 * - Semicolon or comma delimiter (auto-detected from the header row).
 * - Quoted fields with embedded commas, newlines, and escaped quotes.
 * - BOM stripping (UTF-8 BOM `\xEF\xBB\xBF` is common in Excel exports).
 * - Blank row skipping.
 *
 * Returns a header array and a rows array of string arrays. The consumer
 * (column mapper) is responsible for interpreting the values.
 */

export interface ParsedCsv {
	/** Column headers (first non-blank row), trimmed. */
	headers: string[];
	/** Data rows (all rows after the header), same length as headers. */
	rows: string[][];
	/** The delimiter that was detected. */
	delimiter: ',' | ';';
}

/**
 * Strip a leading UTF-8 BOM if present. Excel loves to prepend these.
 */
function stripBom(text: string): string {
	if (text.charCodeAt(0) === 0xfeff) {
		return text.slice(1);
	}
	return text;
}

/**
 * Detect whether the header row uses commas or semicolons as the delimiter.
 * Semicolons are common in European-locale CSV exports (where comma is the
 * decimal separator). We count unquoted occurrences of each in the first line.
 */
function detectDelimiter(headerLine: string): ',' | ';' {
	let commas = 0;
	let semicolons = 0;
	let inQuotes = false;

	for (let i = 0; i < headerLine.length; i++) {
		const ch = headerLine[i];
		if (ch === '"') {
			// Handle escaped quotes ("") inside quoted fields
			if (inQuotes && headerLine[i + 1] === '"') {
				i++; // skip the second quote
				continue;
			}
			inQuotes = !inQuotes;
			continue;
		}
		if (inQuotes) continue;
		if (ch === ',') commas++;
		if (ch === ';') semicolons++;
	}

	return semicolons > commas ? ';' : ',';
}

/**
 * Parse a single CSV line respecting quoted fields. Handles:
 * - Quoted fields with embedded commas/semicolons/newlines
 * - Escaped quotes ("" inside a quoted field)
 * - Trailing whitespace outside quotes is trimmed
 *
 * Returns an array of field values (quotes stripped, internal quotes unescaped).
 */
function parseCsvLine(line: string, delimiter: string): string[] {
	const fields: string[] = [];
	let current = '';
	let inQuotes = false;
	let i = 0;

	while (i < line.length) {
		const ch = line[i];

		if (inQuotes) {
			if (ch === '"') {
				// Check for escaped quote ("")
				if (i + 1 < line.length && line[i + 1] === '"') {
					current += '"';
					i += 2;
					continue;
				}
				// End of quoted field
				inQuotes = false;
				i++;
				continue;
			}
			current += ch;
			i++;
		} else {
			if (ch === '"') {
				inQuotes = true;
				i++;
				continue;
			}
			if (ch === delimiter) {
				fields.push(current.trim());
				current = '';
				i++;
				continue;
			}
			current += ch;
			i++;
		}
	}

	// Push the last field
	fields.push(current.trim());
	return fields;
}

/**
 * Split raw CSV text into lines, respecting quoted fields that may contain
 * embedded newlines. This is necessary because a simple `split('\n')` would
 * break on descriptions containing line breaks.
 */
function splitIntoLines(text: string): string[] {
	const lines: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (ch === '"') {
			if (inQuotes && i + 1 < text.length && text[i + 1] === '"') {
				current += '""';
				i++; // skip escaped quote
				continue;
			}
			inQuotes = !inQuotes;
			current += ch;
			continue;
		}

		if ((ch === '\n' || ch === '\r') && !inQuotes) {
			// Handle \r\n as a single line break
			if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
				i++; // skip the \n after \r
			}
			lines.push(current);
			current = '';
			continue;
		}

		current += ch;
	}

	// Push any remaining content
	if (current.length > 0) {
		lines.push(current);
	}

	return lines;
}

/**
 * Parse CSV text into headers and rows.
 *
 * @param text Raw CSV file contents (may include BOM).
 * @returns Parsed CSV with headers, rows, and detected delimiter.
 * @throws Error if the CSV is empty or has no headers.
 */
export function parseCsv(text: string): ParsedCsv {
	const cleaned = stripBom(text).trim();
	if (!cleaned) {
		throw new Error('CSV file is empty');
	}

	const lines = splitIntoLines(cleaned);

	// Skip blank lines at the top (some exports have a title row or blank line)
	let headerLineIndex = 0;
	while (headerLineIndex < lines.length && lines[headerLineIndex].trim() === '') {
		headerLineIndex++;
	}

	if (headerLineIndex >= lines.length) {
		throw new Error('CSV file has no header row');
	}

	const headerLine = lines[headerLineIndex];
	const delimiter = detectDelimiter(headerLine);
	const headers = parseCsvLine(headerLine, delimiter);

	if (headers.length === 0 || headers.every((h) => h === '')) {
		throw new Error('CSV file has no recognizable headers');
	}

	const rows: string[][] = [];
	for (let i = headerLineIndex + 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === '') continue; // skip blank rows

		const fields = parseCsvLine(lines[i], delimiter);

		// Pad or truncate to match header length
		const row: string[] = [];
		for (let j = 0; j < headers.length; j++) {
			row.push(j < fields.length ? fields[j] : '');
		}
		rows.push(row);
	}

	return { headers, rows, delimiter };
}
