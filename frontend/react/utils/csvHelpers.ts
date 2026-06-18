/**
 * Shared CSV-export helpers used by `csv.ts`, `weekCsvExport.ts`, and
 * `teamCsvExport.ts`. These are byte-for-byte exporter primitives; do
 * not change their output without coordinating with the consumers.
 */

export const CSV_SEP = ';';

/**
 * Neutralise CSV/spreadsheet formula injection. Cells whose leading
 * character is one a spreadsheet would treat as the start of a formula
 * (`=`, `+`, `-`, `@`) or a control char (tab / CR that some parsers strip
 * back to a formula trigger) are prefixed with a single quote so the
 * spreadsheet renders them as literal text. See OWASP "CSV Injection".
 */
function neutralizeFormula(value: string): string {
	if (value.length === 0) return value;
	if (/^[=+\-@\t\r]/.test(value)) {
		return `'${value}`;
	}
	return value;
}

/**
 * Escape a string for inclusion in a CSV cell:
 *  - normalise newlines to spaces and collapse whitespace,
 *  - trim,
 *  - neutralise spreadsheet formula injection (leading `=`/`+`/`-`/`@`),
 *  - quote when the value would otherwise split on `;`/`,` or contain
 *    a literal `"`.
 */
export function csvEscape(value: string): string {
	const safe = neutralizeFormula(
		(value ?? '')
			.replace(/\r?\n|\r/g, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
	);
	if (safe.includes('"') || safe.includes(',') || safe.includes(';')) {
		return `"${safe.replace(/"/g, '""')}"`;
	}
	return safe;
}

export interface CsvProvenance {
	jiraHost?: string;
	sourceVersion?: string;
	generatedAt?: string;
}

export interface ProvenanceFooterOptions {
	policy: 'logged' | 'intended';
	period: string;
	provenance?: CsvProvenance;
	/**
	 * Fallback for missing `jiraHost`. `csv.ts` uses `'unknown'`,
	 * `weekCsvExport` and `teamCsvExport` use `''`.
	 */
	jiraHostFallback?: string;
	/**
	 * Fallback for missing `sourceVersion`. `csv.ts` uses `'dev'`;
	 * the others omit the `version=` field entirely when missing.
	 */
	versionFallback?: string;
	/**
	 * When true and no `sourceVersion` is provided, omit the
	 * `version=...` field rather than emit it with a fallback.
	 */
	omitMissingVersion?: boolean;
}

/**
 * Canonical provenance footer used by all CSV exporters:
 *   # generated=<iso> jira=<host> policy=<policy> period=<period> [version=<v>]
 *
 * Differences between exporters are absorbed via the options:
 * - `csv.ts` passes `jiraHostFallback='unknown'`, `versionFallback='dev'`.
 * - `weekCsvExport`/`teamCsvExport` omit `versionFallback` and instead
 *   set `omitMissingVersion: true` so the field disappears when absent.
 */
/**
 * Make a value safe to embed in a `key=value` pair inside the footer.
 * Strips characters that would collide with the field separator (` `)
 * or break tooling that re-parses the footer (`;`/`,`/`"`).
 * Conservative — only used at footer-build time, not on real data
 * rows.
 */
function escapeFooterValue(value: string): string {
	return value.replace(/[\s;,"]/g, '-');
}

export function buildProvenanceFooter(opts: ProvenanceFooterOptions): string {
	const generatedAt = opts.provenance?.generatedAt ?? new Date().toISOString();
	const jiraHost = opts.provenance?.jiraHost ?? opts.jiraHostFallback ?? '';
	const version = opts.provenance?.sourceVersion ?? opts.versionFallback ?? '';
	const parts = [
		`# generated=${escapeFooterValue(generatedAt)}`,
		`jira=${escapeFooterValue(jiraHost)}`,
		`policy=${opts.policy}`,
		`period=${escapeFooterValue(opts.period)}`,
	];
	if (version || !opts.omitMissingVersion) {
		parts.push(`version=${escapeFooterValue(version)}`);
	}
	return parts.join(' ');
}
