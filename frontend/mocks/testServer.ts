/**
 * Test-env network proxy with error injection (ADA-758).
 *
 * Exposes the SAME mock Jira network the offline/browser mode uses
 * (`./handlers`) inside Vitest, via MSW's Node server, plus a small
 * fault-injection API so tests can reliably simulate service failures:
 *
 *   - `simulateHttpError(...)`   — deterministic HTTP error statuses (500, 429, …)
 *   - `simulateTimeout(...)`     — upstream that never answers within the client's
 *                                  timeout window (client aborts, like production)
 *   - `simulateNetworkError(...)`— the connection itself drops (`TypeError: Failed
 *                                  to fetch`), exercising fetch-level failure paths
 *   - `resetErrorInjection()`    — clears every injected fault, restoring the
 *                                  production handlers between tests
 *
 * Usage in a test file (one opt-in call at module scope):
 *
 *   import { installMockServerHooks } from '../mocks/testServer';
 *   installMockServerHooks();
 *
 * The server starts once per file, faults are reset after every test, and the
 * server closes when the file finishes. Requests that match no handler fail the
 * test (`onUnhandledRequest: 'error'`) so a typo in a pattern can't silently
 * produce a passing-but-useless test.
 *
 * Injected handlers match the route with `http.all`, so every method on the
 * pattern is faulted — predictable regardless of whether the service under test
 * issues GET/POST/… calls.
 */
import { afterAll, afterEach, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { Path } from 'msw';
import { setupServer } from 'msw/node';
import type { SetupServerApi } from 'msw/node';
import { handlers } from './handlers';

/** The shared MSW server. Production handlers are the default (no faults). */
export const server: SetupServerApi = setupServer(...handlers);

/** Error body sent when an injected timeout elapses instead of a client abort. */
const GATEWAY_TIMEOUT_BODY = { message: 'upstream timeout' };

function abortError(): DOMException {
	return new DOMException('The operation was aborted', 'AbortError');
}

// ---------------------------------------------------------------------------
// Vitest integration
// ---------------------------------------------------------------------------

export interface MockServerHooksOptions {
	/**
	 * MSW behavior for requests that match no handler. `'error'` (default)
	 * fails the test on a stray/typo'd request; `'warn'` only logs it.
	 */
	onUnhandledRequest?: 'error' | 'warn';
}

/**
 * Wire the mock server into Vitest lifecycle hooks for the current test file.
 *
 * Call once at module scope:
 *   - `beforeAll`  — start the server, fail on unhandled requests
 *   - `afterEach`  — `resetErrorInjection()` so faults never leak between tests
 *   - `afterAll`   — close the server and restore the real network
 */
export function installMockServerHooks(
	options: MockServerHooksOptions = {},
): void {
	const onUnhandledRequest = options.onUnhandledRequest ?? 'error';
	beforeAll(() => {
		server.listen({ onUnhandledRequest });
	});
	afterEach(() => {
		resetErrorInjection();
	});
	afterAll(() => {
		server.close();
	});
}

// ---------------------------------------------------------------------------
// Error injection
// ---------------------------------------------------------------------------

export interface HttpErrorOptions {
	/** JSON response body (default: `null`). */
	body?: unknown;
	/** Response headers, e.g. `{ 'retry-after': '1' }` for 429 tests. */
	headers?: HeadersInit;
}

/**
 * Simulate an HTTP error: every request matching `pattern` responds with
 * `status` (and the optional JSON body/headers) instead of the mock data.
 *
 * Example — a Jira outage:
 *   simulateHttpError('https://*.atlassian.net/rest/api/3/search/jql', 503);
 *
 * Example — rate limiting with a backoff hint:
 *   simulateHttpError(
 *     'https://*.atlassian.net/rest/api/3/search/jql',
 *     429,
 *     { body: { message: 'Rate limit exceeded' }, headers: { 'retry-after': '1' } },
 *   );
 */
export function simulateHttpError(
	pattern: Path,
	status: number,
	options: HttpErrorOptions = {},
): void {
	server.use(
		http.all(pattern, () =>
			HttpResponse.json(options.body ?? null, {
				status,
				headers: options.headers,
			}),
		),
	);
}

export interface TimeoutOptions {
	/**
	 * How long the upstream stays silent before returning a 504 Gateway
	 * Timeout. Defaults to `Infinity` — the handler never answers and only
	 * settles when the client aborts, which is how a real upstream timeout
	 * presents to `fetch` (an `AbortError`/`TimeoutError` on the caller).
	 * Pass a finite value to simulate a proxy-side timeout: the caller
	 * receives a 504 if it did not abort first.
	 */
	delayMs?: number;
}

/**
 * Simulate a service timeout: the matched route holds the request open and
 * does not respond (or responds 504 after `delayMs`), forcing the caller's own
 * timeout/abort machinery to fire.
 *
 * With the default infinite hold the client must supply a timeout, exactly as
 * production services do:
 *   simulateTimeout('https://*.atlassian.net/rest/api/2/issue/:issueKey');
 *   await expect(
 *     fetch(url, { signal: AbortSignal.timeout(50) }),
 *   ).rejects.toMatchObject({ name: 'TimeoutError' });
 */
export function simulateTimeout(
	pattern: Path,
	options: TimeoutOptions = {},
): void {
	server.use(
		http.all(pattern, ({ request }) => {
			const holdMs = options.delayMs ?? Number.POSITIVE_INFINITY;
			return new Promise<Response>((resolve, reject) => {
				if (request.signal.aborted) {
					reject(abortError());
					return;
				}
				let timer: ReturnType<typeof setTimeout> | undefined;
				const cleanup = () => {
					request.signal.removeEventListener('abort', onAbort);
					if (timer) clearTimeout(timer);
				};
				const onAbort = () => {
					cleanup();
					reject(abortError());
				};
				request.signal.addEventListener('abort', onAbort, { once: true });
				if (Number.isFinite(holdMs)) {
					timer = setTimeout(() => {
						cleanup();
						resolve(
							HttpResponse.json(GATEWAY_TIMEOUT_BODY, {
								status: 504,
							}),
						);
					}, holdMs);
				}
			});
		}),
	);
}

/**
 * Simulate a network-level failure: the connection drops before any response,
 * so `fetch` rejects with `TypeError: Failed to fetch` (MSW `HttpResponse.error`).
 * Exercises fetch-rejection paths that a plain HTTP status cannot reach.
 */
export function simulateNetworkError(pattern: Path): void {
	server.use(http.all(pattern, () => HttpResponse.error()));
}

/**
 * Remove every injected fault and restore the production mock handlers.
 * Run automatically by `installMockServerHooks()` after each test.
 */
export function resetErrorInjection(): void {
	server.resetHandlers();
}
