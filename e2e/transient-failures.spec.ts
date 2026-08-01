import { expect, test, type Page } from '@playwright/test';

/**
 * E2E: transient failures (ADA-759)
 *
 * Validates the retry client (ADA-693/ADA-751) end to end: when Jira search
 * answers with a transient 503, the dashboard stays in its loading state
 * while the client backs off, then retries and renders the week — instead of
 * dying on the first failure.
 *
 * Runs against the offline dev server (MSW mocks `mock.atlassian.net`), so
 * the test is fully hermetic. The failures are injected by patching
 * `window.fetch` in an init script (which runs before the app boots, hence
 * before MSW's service worker): the first `failures` search attempts return a
 * delayed synthetic 503, and later attempts fall through to the real fetch,
 * which the service worker then serves from the MSW handlers.
 */
test.describe('Transient failures (ADA-759)', () => {
	test('recovers from transient 503s and keeps the loader visible while retrying', async ({
		page,
	}) => {
		const { failures, failMs } = { failures: 2, failMs: 300 };

		await page.addInitScript(
			(opts) => {
				const TARGET = '/rest/api/3/search/jql';
				const originalFetch = window.fetch.bind(window);
				let attempts = 0;
				(window as unknown as { __searchAttempts: number }).__searchAttempts =
					0;

				window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const url =
						typeof input === 'string'
							? input
							: input instanceof URL
								? input.href
								: 'url' in input
									? String(input.url)
									: '';
					if (url.includes(TARGET)) {
						attempts += 1;
						(
							window as unknown as { __searchAttempts: number }
						).__searchAttempts = attempts;
						if (attempts <= opts.failures) {
							// Hold the failure open so the loading state is observably
							// present while the client is still retrying.
							await new Promise((resolve) => setTimeout(resolve, opts.failMs));
							return new Response(
								JSON.stringify({
									errorMessages: ['Service Unavailable'],
									errors: {},
								}),
								{
									status: 503,
									headers: { 'content-type': 'application/json' },
								},
							);
						}
					}
					return originalFetch(input, init);
				};
			},
			{ failures, failMs },
		);

		await page.goto('/dashboard');

		// While the first attempts fail and the client backs off, the user
		// sees the loader — the request is retried, not silently dropped.
		const loader = page.getByRole('progressbar', {
			name: 'Loading your week',
		});
		await expect(loader).toBeVisible({ timeout: 15_000 });

		// Recovery: a later attempt succeeds and the week renders.
		await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible({
			timeout: 15_000,
		});
		await expect(loader).not.toBeVisible();

		// The recovery genuinely went through the retry path: more than one
		// search attempt was made against the upstream.
		const searchAttempts = await page.evaluate(
			() =>
				(window as unknown as { __searchAttempts: number }).__searchAttempts,
		);
		expect(searchAttempts).toBeGreaterThan(1);
	});
});
