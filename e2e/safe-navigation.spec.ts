/**
 * ADA-766 — Safe Navigation After Error.
 *
 * Validates that dismissing an alert (the worklog error modal) restores user
 * session integrity: the alert closes, no forced reload or navigation happens,
 * and the app remains fully interactive afterwards.
 */

import { expect, test } from '@playwright/test';

test.describe('Safe navigation after error', () => {
	// Count real page loads so a forced reload after dismissal is detectable:
	// the init script re-runs on every load (including reloads).
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			(window as unknown as { __hmLoads: number }).__hmLoads =
				((window as unknown as { __hmLoads: number }).__hmLoads || 0) + 1;
		});
	});

	test('dismissing the error modal keeps the session intact without a reload', async ({
		page,
	}) => {
		await page.goto('/');
		await expect(page.getByRole('navigation')).toBeVisible();

		// Open the add-worklog modal for the first day card.
		await page.getByRole('button', { name: 'Add worklog' }).first().click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();

		// Guarantee a valid time so the only validation failure is the missing
		// issue key (deterministic, client-side — no network involved).
		await dialog.getByLabel('Time Spent').fill('1h');
		await dialog.getByRole('button', { name: 'Create Worklog' }).click();

		// The inline error is announced as an alert.
		const alert = dialog.getByRole('alert');
		await expect(alert).toContainText('Issue key is required');

		const loadsBefore = await page.evaluate(
			() => (window as unknown as { __hmLoads: number }).__hmLoads,
		);

		// Dismiss the alert (modal close button).
		await dialog.getByRole('button', { name: 'Close' }).click();
		await expect(dialog).not.toBeVisible();

		// No forced reload, no navigation — same page, same session.
		const loadsAfter = await page.evaluate(
			() => (window as unknown as { __hmLoads: number }).__hmLoads,
		);
		expect(loadsAfter).toBe(loadsBefore);
		await expect(page).toHaveURL('/');

		// The dashboard is still fully interactive.
		await expect(
			page.getByRole('button', { name: 'Add worklog' }).first(),
		).toBeVisible();

		// Navigation still works after the error handling.
		await page.getByRole('link', { name: 'Reports' }).click();
		await expect(page).toHaveURL(/\/reports/);
	});
});
