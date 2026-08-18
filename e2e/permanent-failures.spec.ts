import { expect, test } from '@playwright/test';
import { mockPermanentFailure } from './helpers/networkFailures';

/**
 * E2E: permanent failures (ADA-761)
 *
 * Validates the error-simulation interceptor infrastructure end to end: when
 * Jira search answers with a permanent (non-retryable) error on every attempt,
 * the dashboard surfaces its error state instead of hanging in the loader, and
 * the failure stays permanent across user-initiated retries.
 *
 * Runs against the offline dev server (MSW mocks `mock.atlassian.net`), so the
 * test is fully hermetic. The interceptor is installed before the app boots.
 */
test.describe('Permanent failures (ADA-761)', () => {
	test('shows the error state and does not retry on a permanent 403', async ({
		page,
	}) => {
		const interceptor = await mockPermanentFailure(page, {
			urlPattern: '/rest/api/3/search/jql',
			status: 403,
			body: { errorMessages: ['Forbidden'], errors: {} },
		});

		await page.goto('/dashboard');

		// The dashboard surfaces the permanent error instead of dying in the loader.
		await expect(
			page.getByRole('heading', { name: 'Unable to load My Week' }),
		).toBeVisible({ timeout: 15_000 });

		// The failure came from the injected interceptor, not a pass-through.
		expect(await interceptor.attempts()).toBeGreaterThan(0);

		// 403 is permanent: the client fails fast and does not spin up an
		// automatic retry loop — the attempt count stays flat after the initial
		// page-load burst.
		const attempts = await interceptor.attempts();
		await page.waitForTimeout(2_000);
		expect(await interceptor.attempts()).toBe(attempts);
	});

	test('keeps failing on user-initiated retry while the interceptor is installed', async ({
		page,
	}) => {
		const interceptor = await mockPermanentFailure(page, {
			urlPattern: '/rest/api/3/search/jql',
			status: 403,
			body: { errorMessages: ['Forbidden'], errors: {} },
		});

		await page.goto('/dashboard');

		const errorHeading = page.getByRole('heading', {
			name: 'Unable to load My Week',
		});
		await expect(errorHeading).toBeVisible({ timeout: 15_000 });

		const attemptsBefore = await interceptor.attempts();

		// The error state offers a recovery affordance; the interceptor is still
		// installed, so the refetch fails permanently too.
		await page.getByRole('button', { name: 'Try again' }).click();
		await expect(errorHeading).toBeVisible({ timeout: 15_000 });

		expect(await interceptor.attempts()).toBeGreaterThan(attemptsBefore);
	});
});
