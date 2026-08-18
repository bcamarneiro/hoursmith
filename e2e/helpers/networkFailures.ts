import type { Page } from '@playwright/test';

/**
 * E2E network-interceptor helpers for permanent API failures (ADA-761).
 *
 * The Vitest side injects faults through the MSW Node proxy
 * (`frontend/mocks/testServer.ts`); these helpers give Playwright specs the
 * same capability at the browser network layer. `mockPermanentFailure` answers
 * EVERY request matching a URL pattern with an error — no pass-through, no
 * recovery — and exposes an attempt counter so a spec can assert whether the
 * failure was injected at all, stayed permanent across retries, and never
 * healed on its own.
 *
 * The interceptor patches `window.fetch` in an init script, which runs before
 * the app boots and therefore before MSW's service worker — matching the
 * transient-failure spec (ADA-759) so the injected failure is indistinguishable
 * from a real upstream outage.
 */

export interface PermanentFailureOptions {
	/** Substring matched against the request URL (host included). */
	urlPattern: string;
	/** HTTP status for the error response (default `500`). */
	status?: number;
	/** JSON body for the error response (default: a Jira-style error body). */
	body?: unknown;
}

export interface PermanentFailureHandle {
	/**
	 * Number of matching requests the interceptor has answered so far. A spec
	 * can assert the counter is non-zero (the failure was injected), flat after
	 * the initial burst (no automatic retry loop for permanent statuses), and
	 * growing on user-initiated refetches while the interceptor is installed.
	 */
	attempts: () => Promise<number>;
}

/**
 * Permanently fail every request whose URL contains `urlPattern`.
 *
 * Every attempt — the initial fetch, any client retry, and any user-initiated
 * refetch — is answered with `status` (and the optional JSON `body`) until the
 * page closes. The failure never heals on its own, which is what makes it a
 * permanent failure rather than a transient one.
 *
 * @example Fail Jira search with a 403 (permanent, never retried):
 *   const interceptor = await mockPermanentFailure(page, {
 *     urlPattern: '/rest/api/3/search/jql',
 *     status: 403,
 *     body: { errorMessages: ['Forbidden'], errors: {} },
 *   });
 *   await page.goto('/dashboard');
 *   await expect(
 *     page.getByRole('heading', { name: 'Unable to load My Week' }),
 *   ).toBeVisible();
 *   expect(await interceptor.attempts()).toBe(1);
 */
export async function mockPermanentFailure(
	page: Page,
	options: PermanentFailureOptions,
): Promise<PermanentFailureHandle> {
	const {
		urlPattern,
		status = 500,
		body = { errorMessages: ['Internal Server Error'], errors: {} },
	} = options;

	await page.addInitScript(
		({ pattern, statusCode, responseBody }) => {
			const originalFetch = window.fetch.bind(window);
			let attempts = 0;
			(
				window as unknown as { __permanentFailureAttempts: number }
			).__permanentFailureAttempts = 0;

			window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.href
							: 'url' in input
								? String(input.url)
								: '';
				if (url.includes(pattern)) {
					attempts += 1;
					(
						window as unknown as { __permanentFailureAttempts: number }
					).__permanentFailureAttempts = attempts;
					return new Response(JSON.stringify(responseBody), {
						status: statusCode,
						headers: { 'content-type': 'application/json' },
					});
				}
				return originalFetch(input, init);
			};
		},
		{ pattern: urlPattern, statusCode: status, responseBody: body },
	);

	return {
		attempts: () =>
			page.evaluate(
				() =>
					(window as unknown as { __permanentFailureAttempts: number })
						.__permanentFailureAttempts,
			),
	};
}
