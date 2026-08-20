import { expect, test } from '@playwright/test';

test.describe('Navigation', () => {
	test('should load the home page', async ({ page }) => {
		await page.goto('/');

		// Check that the navigation is present
		await expect(
			page.getByRole('navigation', { name: 'Primary' }),
		).toBeVisible();

		// Check for page title
		await expect(page).toHaveTitle(/Hoursmith/i);
	});

	test('should navigate to reports page', async ({ page }) => {
		await page.goto('/');

		await page.getByRole('link', { name: 'Reports' }).click();

		await expect(page).toHaveURL(/\/reports/);
	});

	test('should navigate to settings page', async ({ page }) => {
		await page.goto('/');

		// Click on settings link in navigation
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Settings' })
			.click();

		// Verify URL changed
		await expect(page).toHaveURL(/\/settings/);
	});

	test('should navigate back to home from reports', async ({ page }) => {
		await page.goto('/reports');

		// Click on brand link to go home
		await page.getByRole('link', { name: 'Hoursmith' }).click();

		// Verify URL changed back to home
		await expect(page).toHaveURL('/');
	});
});
