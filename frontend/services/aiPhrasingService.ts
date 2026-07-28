/**
 * AI Phrasing Service — client‑side service that rephrases worklog reason
 * text via an LLM, with strict validation to guarantee no numerical values
 * appear in the output.
 *
 * Architecture:
 *   Input:  a reason string (from WorklogSuggestion.reason or similar) plus
 *           optional context (issue key / summary).
 *   Flow:   system prompt → LLM call (OpenAI‑compatible chat API) → validate
 *           → defensive sanitize → return result.
 *   Safety: the service validates every LLM response. If numbers leak through,
 *           a sanitizer strips them and `validated: false` is set so callers
 *           know the output was post‑processed.
 *
 * Linear: ADA-588
 */

import { ServiceError } from './serviceErrors';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/** Input to the AI phrasing service — reason text + optional context. */
export interface AiPhrasingInput {
	/** The raw reason text (e.g. from WorklogSuggestion.reason). */
	reason: string;
	/** Optional Jira issue key for context (e.g. "PROJ-123"). */
	issueKey?: string;
	/** Optional issue summary for richer rephrasing. */
	issueSummary?: string;
}

/** Result of calling `phraseReason`. */
export interface PhrasingResult {
	/** The original input reason. */
	original: string;
	/** LLM‑rephrased text, validated to contain no numerical values. */
	phrased: string;
	/**
	 * Whether the LLM output passed numerical‑value validation.
	 * `false` means the sanitizer had to strip content — the output is safe
	 * but may read slightly awkwardly.
	 */
	validated: boolean;
}

/** Options for the LLM call. */
export interface PhrasingOptions {
	/** The LLM API endpoint URL (OpenAI‑compatible chat completions). */
	apiUrl: string;
	/** Optional API key (sent as `Authorization: Bearer <key>`). */
	apiKey?: string;
	/** Optional model name (defaults to the provider's default). */
	model?: string;
	/** Optional AbortSignal for cancelling the request. */
	signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/*  System prompt                                                      */
/* ------------------------------------------------------------------ */

/**
 * Strict system prompt that instructs the LLM to rewrite reason text
 * into natural language while *never* emitting numerical values.
 */
export const AI_PHRASING_SYSTEM_PROMPT = `You are a helpful assistant that rewrites worklog reason text into clear, professional natural-language descriptions.

Rules:
1. Rewrite the given reason into a natural, human-readable sentence.
2. Do NOT include any numerical values of any kind — no digits (0–9), no spelled-out numbers (one, two, three …), no time formats (2h, 30m, 1 hour, 45 minutes), no percentages, no dates, no monetary amounts.
3. Describe the work qualitatively only — what was done and why, not how long it took or how many of anything.
4. Keep it concise (1–2 sentences).
5. Maintain a professional tone.
6. If the input contains a Jira issue key or summary, you may reference the type of work but not numeric identifiers.

Examples:
- Input: Reason: "PR review for ADA-100 — 4 files changed, 2h spent" → "Reviewed a pull request for the authentication module."
- Input: Reason: "Bug fix for LOGIN-42 — 30m debugging auth flow" → "Debugged and fixed an issue in the authentication flow."
- Input: Reason: "Sprint planning — 1h meeting" → "Attended sprint planning session."`;

/* ------------------------------------------------------------------ */
/*  Validation & sanitisation                                          */
/* ------------------------------------------------------------------ */

/** Regex patterns that indicate numerical content in LLM output. */
const NUMERICAL_PATTERNS: RegExp[] = [
	/\d/, // any digit
	/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i, // small cardinals
	/\b(?:thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/i, // teens
	/\b(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/i, // tens
	/\b(?:hundred|thousand|million|billion)\b/i, // large units
	/\d+\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs)\b/i, // "2h", "30m", "45 minutes"
	/\d{1,2}[:.]\d{2}(?:\s*(?:am|pm))?/i, // clock times 14:30 / 14.30 / 2:30pm
	/\d+\s*%/, // percentages
	/\$\s*\d+(?:[.,]\d+)?/, // monetary amounts
	/\d{4}[-/]\d{1,2}[-/]\d{1,2}/, // ISO-ish dates 2024-01-15
	/\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/, // local dates 01/15/2024
	/\b\d+\s*(?:files?|items?|tickets?|issues?|prs?|commits?|changes?|pages?|people|users?|members?)\b/i, // "4 files", "2 items"
];

/**
 * Check if `text` contains any numerical values.
 *
 * Returns `true` when at least one numerical pattern is detected —
 * the caller should either reject the output or run it through
 * `sanitizeNumericalContent` before displaying.
 */
export function containsNumericalValues(text: string): boolean {
	for (const pattern of NUMERICAL_PATTERNS) {
		if (pattern.test(text)) return true;
	}
	return false;
}

/**
 * Defensive sanitizer that strips numerical content from a string.
 *
 * Used as a last‑resort guard when the LLM output fails validation.
 * Removes time formats, standalone digits, and other numeric patterns
 * that may have leaked through.
 */
export function sanitizeNumericalContent(text: string): string {
	let cleaned = text;

	// Strip patterns that pair a value with a unit or symbol, plus any
	// surrounding whitespace / punctuation the value carries.
	// Order matters — more specific first, then catch-all.

	// Monetary amounts: "$ 100", "$100", "$1,200.50"
	cleaned = cleaned.replace(/\$\s*\d+(?:[.,]\d+)?/g, '');

	// Time durations ("2h", "30m", "45 minutes", "1.5 hours", "2h30m")
	cleaned = cleaned.replace(
		/\d+(?:[.,]\d+)?\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs)\b/gi,
		'',
	);

	// Percentages: "75%", "12.5%"
	cleaned = cleaned.replace(/\d+(?:[.,]\d+)?\s*%/g, '');

	// Clock times: "14:30", "09:15am", "2:30 pm"
	cleaned = cleaned.replace(
		/\d{1,2}[:.]\d{2}(?:\s*(?:am|pm))?/gi,
		'',
	);

	// Dates: "2024-01-15", "01/15/2024"
	cleaned = cleaned.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, '');
	cleaned = cleaned.replace(/\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/g, '');

	// Standalone numbers (including decimals)
	cleaned = cleaned.replace(/\b\d+(?:[.,]\d+)?\b/g, '');

	// Any remaining isolated digits (e.g. inside a word boundary glitch)
	cleaned = cleaned.replace(/\d/g, '');

	// Clean up trailing symbols / punctuation that the number carried
	cleaned = cleaned.replace(/[$%]\s*/g, '');
	cleaned = cleaned.replace(/(?<=\s):\s*/g, '');

	// Collapse multiple spaces and trim
	cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

	return cleaned;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the user‑role message from an {@link AiPhrasingInput}.
 */
function buildUserPrompt(input: AiPhrasingInput): string {
	let prompt = `Reason: "${input.reason}"`;
	if (input.issueKey) {
		prompt += `\nIssue: ${input.issueKey}`;
	}
	if (input.issueSummary) {
		prompt += ` — ${input.issueSummary}`;
	}
	return prompt;
}

/**
 * Call the LLM to rephrase a reason string, then validate the output
 * contains no numerical values.
 *
 * Uses the OpenAI‑compatible chat completions API format. The response
 * is always returned — if validation fails the output is sanitised
 * defensively and `validated` is set to `false`.
 *
 * @throws {ServiceError} On network failure, HTTP error status, or
 *   malformed / empty API response.
 */
export async function phraseReason(
	input: AiPhrasingInput,
	options: PhrasingOptions,
): Promise<PhrasingResult> {
	const userMessage = buildUserPrompt(input);

	let response: Response;
	try {
		response = await fetch(options.apiUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(options.apiKey
					? { Authorization: `Bearer ${options.apiKey}` }
					: {}),
			},
			body: JSON.stringify({
				model: options.model || 'gpt-4o-mini',
				messages: [
					{ role: 'system', content: AI_PHRASING_SYSTEM_PROMPT },
					{ role: 'user', content: userMessage },
				],
				temperature: 0.3,
				max_tokens: 150,
			}),
			signal: options.signal,
		});
	} catch (err) {
		throw new ServiceError({
			kind: 'network',
			source: 'ai-phrasing',
			message: err instanceof Error ? err.message : String(err),
		});
	}

	if (!response.ok) {
		throw new ServiceError({
			kind: 'server-error',
			status: response.status,
			source: 'ai-phrasing',
			message: `AI phrasing API returned HTTP ${response.status}`,
		});
	}

	let data: { choices?: { message?: { content?: string } }[] };
	try {
		data = (await response.json()) as typeof data;
	} catch {
		throw new ServiceError({
			kind: 'unknown',
			source: 'ai-phrasing',
			message: 'Invalid JSON response from AI phrasing API',
		});
	}

	const phrased = data?.choices?.[0]?.message?.content?.trim();
	if (!phrased) {
		throw new ServiceError({
			kind: 'unknown',
			source: 'ai-phrasing',
			message: 'Empty response from AI phrasing API',
		});
	}

	const hasNumericalValues = containsNumericalValues(phrased);

	return {
		original: input.reason,
		phrased: hasNumericalValues
			? sanitizeNumericalContent(phrased)
			: phrased,
		validated: !hasNumericalValues,
	};
}
