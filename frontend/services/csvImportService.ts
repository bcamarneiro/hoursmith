/**
 * Maps CSV columns from various time-tracking tools to Jira worklog entries.
 *
 * Supports auto-detection of common formats (Toggl, Clockify, Harvest, Tempo)
 * and manual column mapping for generic CSVs.
 *
 * Each row is mapped to a `WorklogDraft` that the caller can submit via
 * `useWorklogOperations.createMultipleWorklogs`.
 */

import type { ParsedCsv } from '../react/utils/csvImportParser';

/** A draft worklog ready for submission to Jira. */
export interface WorklogDraft {
	/** Jira issue key (e.g. "PROJ-123"). */
	issueKey: string;
	/** Human-readable duration string (e.g. "1h 30m", "2h", "45m"). */
	timeSpent: string;
	/** Worklog comment / description. */
	comment: string;
	/** ISO date string for when the work was performed (YYYY-MM-DD). */
	started: string;
}

/** Column mapping indices — which CSV column holds each piece of data. */
export interface ColumnMapping {
	/** Column index for the date/worklog date. */
	date: number;
	/** Column index for the Jira issue key. */
	issueKey: number;
	/** Column index for the duration/time spent. */
	duration: number;
	/** Column index for the description/comment. */
	description: number;
}

/** Known time-tracking tool presets for auto-detection. */
export type ToolPreset = 'toggl' | 'clockify' | 'harvest' | 'tempo' | 'generic';

/** Result of auto-detecting a tool preset from headers. */
export interface PresetDetection {
	preset: ToolPreset;
	mapping: ColumnMapping | null;
	confidence: 'high' | 'medium' | 'low';
}

// ─── Header matching helpers ───────────────────────────────────────────────

/** Normalize a header name for fuzzy matching. */
function normalizeHeader(h: string): string {
	return h
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '')
		.trim();
}

/** Find the index of a header matching any of the given normalized candidates. */
function findHeaderIndex(
	headers: string[],
	candidates: string[],
): number {
	const normalized = headers.map(normalizeHeader);
	for (const candidate of candidates) {
		const idx = normalized.indexOf(candidate);
		if (idx !== -1) return idx;
	}
	return -1;
}

// ─── Preset detection ──────────────────────────────────────────────────────

/**
 * Detect which time-tracking tool produced the CSV based on header names.
 * Returns the detected preset and a suggested column mapping.
 */
export function detectPreset(parsed: ParsedCsv): PresetDetection {
	const { headers } = parsed;

	// Toggl Track: "Description", "Duration", "Date" (or "Start date"), "Project"
	const togglDate = findHeaderIndex(headers, ['date', 'startdate', 'start']);
	const togglDesc = findHeaderIndex(headers, ['description', 'task']);
	const togglDur = findHeaderIndex(headers, ['duration', 'time']);
	const togglProject = findHeaderIndex(headers, ['project']);

	if (togglDate !== -1 && togglDur !== -1 && (togglDesc !== -1 || togglProject !== -1)) {
		// For Toggl, the issue key is usually in the description or project field
		const issueKeyCol = togglDesc !== -1 ? togglDesc : togglProject;
		return {
			preset: 'toggl',
			mapping: {
				date: togglDate,
				issueKey: issueKeyCol,
				duration: togglDur,
				description: togglDesc !== -1 ? togglDesc : togglProject,
			},
			confidence: 'high',
		};
	}

	// Clockify: "Project", "Description", "Date" (or "Start"), "Duration (h)"
	const clockifyDate = findHeaderIndex(headers, ['date', 'start', 'startdate']);
	const clockifyDesc = findHeaderIndex(headers, ['description']);
	const clockifyDur = findHeaderIndex(headers, ['durationh', 'duration']);
	const clockifyProject = findHeaderIndex(headers, ['project']);

	if (clockifyDate !== -1 && clockifyDur !== -1) {
		const issueKeyCol = clockifyProject !== -1 ? clockifyProject : clockifyDesc;
		return {
			preset: 'clockify',
			mapping: {
				date: clockifyDate,
				issueKey: issueKeyCol !== -1 ? issueKeyCol : 0,
				duration: clockifyDur,
				description: clockifyDesc !== -1 ? clockifyDesc : clockifyProject,
			},
			confidence: 'high',
		};
	}

	// Harvest: "Date", "Hours", "Notes", "Client", "Project", "Task"
	const harvestDate = findHeaderIndex(headers, ['date']);
	const harvestHours = findHeaderIndex(headers, ['hours', 'roundedhours', 'rounded']);
	const harvestNotes = findHeaderIndex(headers, ['notes', 'comment', 'description']);
	const harvestProject = findHeaderIndex(headers, ['project']);

	if (harvestDate !== -1 && harvestHours !== -1) {
		const issueKeyCol = harvestProject !== -1 ? harvestProject : harvestNotes;
		return {
			preset: 'harvest',
			mapping: {
				date: harvestDate,
				issueKey: issueKeyCol !== -1 ? issueKeyCol : 0,
				duration: harvestHours,
				description: harvestNotes !== -1 ? harvestNotes : harvestProject,
			},
			confidence: 'high',
		};
	}

	// Tempo: "Date", "Issue Key" (or "Issue"), "Time Spent" (or "Duration"), "Description"
	const tempoDate = findHeaderIndex(headers, ['date', 'worklogdate']);
	const tempoIssue = findHeaderIndex(headers, ['issuekey', 'issue', 'issuekeyorid']);
	const tempoDur = findHeaderIndex(headers, ['timespent', 'duration', 'timespentseconds']);
	const tempoDesc = findHeaderIndex(headers, ['description', 'comment']);

	if (tempoDate !== -1 && tempoIssue !== -1 && tempoDur !== -1) {
		return {
			preset: 'tempo',
			mapping: {
				date: tempoDate,
				issueKey: tempoIssue,
				duration: tempoDur,
				description: tempoDesc !== -1 ? tempoDesc : tempoIssue,
			},
			confidence: 'high',
		};
	}

	// Generic fallback: try to find date, issue key, duration, description columns
	const genericDate = findHeaderIndex(headers, [
		'date', 'startdate', 'worklogdate', 'day', 'when',
	]);
	const genericIssue = findHeaderIndex(headers, [
		'issuekey', 'issue', 'key', 'ticket', 'task', 'project',
	]);
	const genericDur = findHeaderIndex(headers, [
		'duration', 'timespent', 'hours', 'time', 'time spent',
	]);
	const genericDesc = findHeaderIndex(headers, [
		'description', 'comment', 'notes', 'summary', 'details',
	]);

	if (genericDate !== -1 && genericDur !== -1) {
		return {
			preset: 'generic',
			mapping: {
				date: genericDate,
				issueKey: genericIssue !== -1 ? genericIssue : 0,
				duration: genericDur,
				description: genericDesc !== -1 ? genericDesc : genericIssue,
			},
			confidence: genericIssue !== -1 ? 'medium' : 'low',
		};
	}

	return { preset: 'generic', mapping: null, confidence: 'low' };
}

// ─── Duration parsing ──────────────────────────────────────────────────────

/**
 * Parse a duration string into total seconds. Handles multiple formats:
 *
 * - "1h 30m" → 5400
 * - "1.5h" → 5400
 * - "90m" → 5400
 * - "5400" (bare number, assumed seconds) → 5400
 * - "1:30" (hours:minutes) → 5400
 * - "01:30:00" (hours:minutes:seconds) → 5400
 * - "1h30m" (no space) → 5400
 * - Toggl/Clockify format: "01:30:00" → 5400
 *
 * Returns 0 if the value cannot be parsed.
 */
export function parseDuration(raw: string): number {
	if (!raw) return 0;
	const value = raw.trim();
	if (!value) return 0;

	// Try hours:minutes:seconds format (e.g. "1:30:00" or "01:30:00")
	const hmsMatch = value.match(/^(\d+):(\d+)(?::(\d+))?$/);
	if (hmsMatch) {
		const hours = Number.parseInt(hmsMatch[1], 10);
		const minutes = Number.parseInt(hmsMatch[2], 10);
		const seconds = hmsMatch[3] ? Number.parseInt(hmsMatch[3], 10) : 0;
		return hours * 3600 + minutes * 60 + seconds;
	}

	// Try "Xh Ym Zs" format (with optional parts, flexible whitespace).
	// At least one suffix letter (h/m/s) must be present — bare numbers are
	// handled by the decimal-hours fallback below.
	const hmsPattern = /(?:(\d+(?:\.\d+)?)\s*h)\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?|(?:(\d+(?:\.\d+)?)\s*m(?:in)?)\s*(?:(\d+(?:\.\d+)?)\s*s)?|(?:(\d+(?:\.\d+)?)\s*s)/i;
	const hmsTextMatch = value.match(hmsPattern);
	if (hmsTextMatch) {
		const hours = hmsTextMatch[1] ? Number.parseFloat(hmsTextMatch[1]) : 0;
		const minutes = hmsTextMatch[2]
			? Number.parseFloat(hmsTextMatch[2])
			: hmsTextMatch[4]
				? Number.parseFloat(hmsTextMatch[4])
				: 0;
		const seconds = hmsTextMatch[3]
			? Number.parseFloat(hmsTextMatch[3])
			: hmsTextMatch[5]
				? Number.parseFloat(hmsTextMatch[5])
				: hmsTextMatch[6]
					? Number.parseFloat(hmsTextMatch[6])
					: 0;
		return Math.round(hours * 3600 + minutes * 60 + seconds);
	}

	// Try decimal hours (e.g. "1.5" meaning 1.5 hours)
	const decimalHours = Number.parseFloat(value);
	if (!Number.isNaN(decimalHours) && decimalHours > 0) {
		// Heuristic: if the number is small (< 24), assume hours; otherwise seconds
		if (decimalHours < 24) {
			return Math.round(decimalHours * 3600);
		}
		// Large numbers are likely seconds
		return Math.round(decimalHours);
	}

	return 0;
}

/**
 * Convert seconds to a Jira-compatible time string (e.g. "1h 30m", "2h", "45m").
 */
export function secondsToJiraTime(totalSeconds: number): string {
	if (totalSeconds <= 0) return '';

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.round((totalSeconds % 3600) / 60);

	if (hours > 0 && minutes > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (hours > 0) {
		return `${hours}h`;
	}
	return `${minutes}m`;
}

// ─── Date parsing ──────────────────────────────────────────────────────────

/**
 * Parse a date string from a CSV into an ISO date (YYYY-MM-DD).
 * Handles common formats:
 * - "2024-01-15" (ISO)
 * - "01/15/2024" (US)
 * - "15/01/2024" (EU — only when day > 12 to disambiguate)
 * - "2024-01-15T10:30:00Z" (ISO with time)
 * - "Jan 15, 2024" (English month name)
 * - "15-Jan-2024"
 *
 * Returns null if the date cannot be parsed.
 */
export function parseDate(raw: string): string | null {
	if (!raw) return null;
	const value = raw.trim();
	if (!value) return null;

	// Try ISO format first: YYYY-MM-DD or YYYY-MM-DDThh:mm:ss
	const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
	if (isoMatch) {
		const year = Number.parseInt(isoMatch[1], 10);
		const month = Number.parseInt(isoMatch[2], 10);
		const day = Number.parseInt(isoMatch[3], 10);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			return `${year.toString()}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
		}
	}

	// Try US format: MM/DD/YYYY or MM-DD-YYYY
	const usMatch = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
	if (usMatch) {
		const first = Number.parseInt(usMatch[1], 10);
		const second = Number.parseInt(usMatch[2], 10);
		const year = Number.parseInt(usMatch[3], 10);

		// If first > 12, it must be a day (EU format: DD/MM/YYYY)
		if (first > 12 && second <= 12) {
			return `${year.toString()}-${second.toString().padStart(2, '0')}-${first.toString().padStart(2, '0')}`;
		}
		// Default to US format: MM/DD/YYYY
		if (first >= 1 && first <= 12 && second >= 1 && second <= 31) {
			return `${year.toString()}-${first.toString().padStart(2, '0')}-${second.toString().padStart(2, '0')}`;
		}
	}

	// Try "Jan 15, 2024" or "15 Jan 2024" or "15-Jan-2024"
	const monthNames: Record<string, number> = {
		jan: 1, january: 1,
		feb: 2, february: 2,
		mar: 3, march: 3,
		apr: 4, april: 4,
		may: 5,
		jun: 6, june: 6,
		jul: 7, july: 7,
		aug: 8, august: 8,
		sep: 9, september: 9,
		oct: 10, october: 10,
		nov: 11, november: 11,
		dec: 12, december: 12,
	};

	// "Month DD, YYYY" or "DD Month YYYY"
	const monthNameMatch = value.match(
		/(\d{1,2})[,\s-]+([a-zA-Z]+)[,\s-]+(\d{4})/,
	);
	if (monthNameMatch) {
		const day = Number.parseInt(monthNameMatch[1], 10);
		const monthStr = monthNameMatch[2].toLowerCase();
		const year = Number.parseInt(monthNameMatch[3], 10);
		const month = monthNames[monthStr];
		if (month && day >= 1 && day <= 31) {
			return `${year.toString()}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
		}
	}

	// "Month DD, YYYY" with month first
	const monthFirstMatch = value.match(
		/([a-zA-Z]+)[,\s-]+(\d{1,2})[,\s-]+(\d{4})/,
	);
	if (monthFirstMatch) {
		const monthStr = monthFirstMatch[1].toLowerCase();
		const day = Number.parseInt(monthFirstMatch[2], 10);
		const year = Number.parseInt(monthFirstMatch[3], 10);
		const month = monthNames[monthStr];
		if (month && day >= 1 && day <= 31) {
			return `${year.toString()}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
		}
	}

	// Last resort: try Date constructor (handles many formats)
	const fallback = new Date(value);
	if (!Number.isNaN(fallback.getTime())) {
		const y = fallback.getFullYear();
		const m = fallback.getMonth() + 1;
		const d = fallback.getDate();
		return `${y.toString()}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
	}

	return null;
}

// ─── Issue key extraction ─────────────────────────────────────────────────

/** Jira issue key pattern: PROJECT-123 */
const ISSUE_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/i;

/**
 * Extract a Jira issue key from a string. The string might be a bare key
 * ("PROJ-123") or contain one in a description ("Fixed PROJ-123 login bug").
 *
 * Returns null if no valid key is found.
 */
export function extractIssueKey(raw: string): string | null {
	if (!raw) return null;
	const match = raw.match(ISSUE_KEY_PATTERN);
	if (match) {
		return match[1].toUpperCase();
	}
	return null;
}

// ─── Row mapping ──────────────────────────────────────────────────────────

export interface MappingResult {
	/** Successfully mapped worklog drafts. */
	drafts: WorklogDraft[];
	/** Rows that could not be mapped (with reasons). */
	skipped: Array<{ rowIndex: number; reason: string; raw: string[] }>;
}

/**
 * Map parsed CSV rows to worklog drafts using the given column mapping.
 *
 * - Extracts issue keys from the mapped column (supports embedded keys).
 * - Parses durations into Jira-compatible time strings.
 * - Parses dates into ISO format.
 * - Skips rows with missing or unparseable required fields.
 */
export function mapRowsToDrafts(
	parsed: ParsedCsv,
	mapping: ColumnMapping,
): MappingResult {
	const drafts: WorklogDraft[] = [];
	const skipped: Array<{ rowIndex: number; reason: string; raw: string[] }> = [];

	for (let i = 0; i < parsed.rows.length; i++) {
		const row = parsed.rows[i];
		const rowIndex = i + 1; // 1-indexed for user-facing messages

		// Extract and validate each field
		const dateRaw = row[mapping.date] ?? '';
		const issueKeyRaw = row[mapping.issueKey] ?? '';
		const durationRaw = row[mapping.duration] ?? '';
		const descriptionRaw =
			mapping.description >= 0 && mapping.description < row.length
				? row[mapping.description]
				: '';

		const date = parseDate(dateRaw);
		if (!date) {
			skipped.push({
				rowIndex,
				reason: `Unparseable date: "${dateRaw}"`,
				raw: row,
			});
			continue;
		}

		let issueKey = extractIssueKey(issueKeyRaw);

		// Fall back to description column if issue key column is empty
		if (!issueKey && mapping.description !== mapping.issueKey) {
			issueKey = extractIssueKey(descriptionRaw);
		}

		if (!issueKey) {
			skipped.push({
				rowIndex,
				reason: `No Jira issue key found in: "${issueKeyRaw || descriptionRaw}"`,
				raw: row,
			});
			continue;
		}

		const totalSeconds = parseDuration(durationRaw);
		if (totalSeconds <= 0) {
			skipped.push({
				rowIndex,
				reason: `Unparseable or zero duration: "${durationRaw}"`,
				raw: row,
			});
			continue;
		}

		const timeSpent = secondsToJiraTime(totalSeconds);
		const comment = descriptionRaw.trim() || issueKey;

		drafts.push({
			issueKey,
			timeSpent,
			comment,
			started: date,
		});
	}

	return { drafts, skipped };
}
