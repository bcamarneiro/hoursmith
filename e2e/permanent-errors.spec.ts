import { expect, test } from '@playwright/test';

/**
 * Validates that non-retryable error paths display accessible error alerts
 * and allow the user to safely navigate away (ADA-760).
 */
test.describe('Permanent error handling', () => {
	test('shows accessible error alert on non-retryable Jira auth failure and allows navigation away', async ({
		page,
	}) => {
		// Intercept the Jira /myself endpoint with a 401 — a permanent,
		// non-retryable status that must show an accessible alert.
		await page.route('**/rest/api/2/myself**', async (route) => {
			await route.fulfill({
				status: 401,
				contentType: 'application/json',
				body: JSON.stringify({ errorMessages: ['Unauthorized'] }),
			});
		});

		await page.goto('/settings');
		await page.waitForLoadState('networkidle');

		// Fill in Jira credentials so the Test button is enabled.
		await page.getByLabel('Jira Host').fill('my.atlassian.net');
		await page.getByLabel('Email').fill('user@example.com');
		await page.getByLabel('API Token').fill('some-token');

		// Trigger the connection test.
		await page.getByRole('button', { name: 'Test' }).click();

		// Assert an accessible error alert appears — the ConnectionSection
		// inline result element now carries role="alert" on failures.
		const errorAlert = page.locator('[role="alert"]');
		await expect(errorAlert).toBeVisible({ timeout: 10000 });
		await expect(errorAlert).toContainText(/401|Unauthorized/);

		// Navigate away to verify the user can safely leave the error state.
		await page
			.getByRole('navigation')
			.getByRole('link', { name: 'Dashboard' })
			.click();
		await expect(page).toHaveURL(/\/dashboard/);
	});
});
