/**
 * Global error interceptor (ADA-694).
 *
 * Every API error that should reach the user flows through `reportError`:
 *  - query/mutation errors are routed here via the QueryClient cache hooks
 *    (frontend/react/queryClient.ts);
 *  - action handlers (DayCard / SuggestionCard) call it directly.
 *
 * The interceptor guarantees one pipeline everywhere:
 *
 *   normalize (unknown → ServiceError) → map (describeServiceError) →
 *   dedupe / burst-guard → accessible toast with the mapped recovery action.
 *
 * Where a page renders its own dominant error state (e.g. My Week's full-page
 * worklogs failure with its own retry), the query opts out via
 * `meta: { suppressErrorToast: true }` so the user never gets double feedback.
 */
import { toast } from '../react/components/ui/Toast';
import { isHashRouterMode, withBasePath } from '../react/utils/runtimeConfig';
import {
	describeServiceError,
	fromRichMessage,
	ServiceError,
	type ServiceErrorCopy,
} from './serviceErrors';

export interface ReportErrorOptions {
	/**
	 * Skip the toast but still return the mapped copy. Use when the caller
	 * renders its own inline error UI and only wants the standardized copy.
	 */
	silent?: boolean;
	/** Source label when the error isn't already a ServiceError. */
	source?: string;
	/** Message used when `error` is null/undefined (avoids "undefined" copy). */
	fallbackMessage?: string;
}

/** How long the same message is considered "already shown". */
const DEDUPE_WINDOW_MS = 15_000;
/** Window over which distinct errors are burst-counted. */
const BURST_WINDOW_MS = 10_000;
/** Max distinct error toasts per burst window (avoids toast storms). */
const MAX_BURST_TOASTS = 3;

/**
 * Sniffs an HTTP status out of a raw error message ("Jira API error: 401 - …")
 * so legacy throw sites still classify into the canonical kind.
 */
const HTTP_STATUS_RE =
	/(?:^|[^0-9a-zA-Z])(401|403|404|429|5\d\d)(?:$|[^0-9a-zA-Z])/;

const lastShownByMessage = new Map<string, number>();
let burstWindowStart = 0;
let burstToastCount = 0;

/**
 * Normalize any thrown value into the standardized `ServiceError` shape so
 * downstream UI can rely on `kind` / `status` / `source`. Status is sniffed
 * from raw messages (e.g. "Jira API error: 401 - ...") so legacy throw sites
 * still classify correctly.
 */
export function normalizeError(error: unknown, source = 'API'): ServiceError {
	if (error instanceof ServiceError) return error;
	if (error == null) {
		return fromRichMessage(source, undefined, 'Unknown error');
	}

	const message = error instanceof Error ? error.message : String(error);
	const statusMatch = message.match(HTTP_STATUS_RE);
	const status = statusMatch ? Number(statusMatch[1]) : undefined;
	return fromRichMessage(source, status, message);
}

/**
 * Report an API error to the user. Returns the mapped copy so callers can also
 * render it inline. The toast is deduped (same message within the window) and
 * burst-guarded (max distinct toasts per window) so a page-load of parallel
 * failing queries produces one clear notice instead of a toast storm.
 */
export function reportError(
	error: unknown,
	options: ReportErrorOptions = {},
): ServiceErrorCopy {
	const normalized = normalizeError(
		error ?? options.fallbackMessage,
		options.source,
	);
	const copy = describeServiceError(normalized);

	if (!options.silent) {
		const now = Date.now();

		// Prune stale entries so the map can't grow unbounded.
		if (lastShownByMessage.size >= 128) {
			for (const [message, at] of lastShownByMessage) {
				if (now - at > DEDUPE_WINDOW_MS) lastShownByMessage.delete(message);
			}
		}

		const lastShown = lastShownByMessage.get(copy.message);
		if (lastShown !== undefined && now - lastShown <= DEDUPE_WINDOW_MS) {
			return copy; // Same failure already surfaced recently.
		}

		if (now - burstWindowStart > BURST_WINDOW_MS) {
			burstWindowStart = now;
			burstToastCount = 0;
		}

		if (burstToastCount >= MAX_BURST_TOASTS) {
			console.warn(
				`[errorInterceptor] suppressed error toast: ${copy.message}`,
			);
			lastShownByMessage.set(copy.message, now);
			return copy;
		}

		burstToastCount += 1;
		lastShownByMessage.set(copy.message, now);

		const action = copy.action;
		toast.error(copy.message, {
			action: action && {
				label: action.label,
				onClick: () => navigateTo(action.to),
			},
		});
	}

	return copy;
}

function navigateTo(path: string): void {
	const target = isHashRouterMode ? `#${path}` : withBasePath(path);
	window.location.assign(target);
}

/** Reset dedupe/burst state. Tests only. */
export function __resetErrorInterceptorForTests(): void {
	lastShownByMessage.clear();
	burstWindowStart = 0;
	burstToastCount = 0;
}
