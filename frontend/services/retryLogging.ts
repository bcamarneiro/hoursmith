/**
 * Structured retry-event logger (ADA-736).
 *
 * Emits machine-parseable events for every retry decision so monitoring
 * dashboards and error-reporting tools can surface retry storms, rate-limiting
 * patterns, and backoff efficacy without grepping ad-hoc console lines.
 *
 * Events are logged via `console.warn` (retry attempts) and `console.error`
 * (exhausted retries) so they are visible in dev-tools and collected by
 * frontend-error reporters. In production the `StructuredRetryEvent` objects
 * are preserved as the first argument for structured-log ingest pipelines.
 */

// ---------------------------------------------------------------------------
// Event type
// ---------------------------------------------------------------------------

export type RetryEventKind =
	| 'retry_attempt'        // transient — will retry after backoff
	| 'retry_exhausted';     // terminal — all attempts consumed

export interface StructuredRetryEvent {
	/** Discriminant so consumers can branch without inspecting fields. */
	event: RetryEventKind;
	/**
	 * The request URL (path + query only — never includes credentials in the
	 * query string, which some APIs require). Redact if needed before calling.
	 */
	url: string;
	/** Zero-based attempt index (0 = first attempt). */
	attempt: number;
	/** Configured maxRetries. */
	maxRetries: number;
	/** HTTP status that triggered the retry, if applicable. */
	status?: number;
	/** Backoff delay in ms before the next attempt. */
	delayMs: number;
	/** Short error summary when a network error triggered the retry. */
	error?: string;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export function logStructuredRetry(event: StructuredRetryEvent): void {
	if (event.event === 'retry_exhausted') {
		console.error(
			`[retryClient] Exhausted retries for ${event.url}`,
			event,
		);
	} else {
		console.warn(
			`[retryClient] Retry ${event.attempt}/${event.maxRetries} for ${event.url} (${event.delayMs}ms)`,
			event,
		);
	}
}
