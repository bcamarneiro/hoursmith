import { expect, test } from '@playwright/test';

test.describe('Smoke rollout paths', () => {
	test('home and my week surface the main product entry points', async ({
		page,
	}) => {
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		await expect(
			page.getByRole('link', { name: 'Open My Week' }),
		).toBeVisible();
		const nav = page.getByRole('navigation');
		await expect(nav.getByRole('link', { name: 'My Week' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Reports' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();

		await page.getByRole('link', { name: 'Open My Week' }).click();
		await expect(page).toHaveURL(/\/my-week/);
		await expect(page.getByText('Close assistant')).toBeVisible();
		await expect(
			page.getByRole('button', { name: /Copy Prev Week/ }),
		).toBeVisible();
	});

	test('settings shows onboarding and exports a backup', async ({ page }) => {
		await page.goto('/settings');
		await page.waitForLoadState('networkidle');

		await expect(page.getByText('Setup wizard')).toBeVisible();
		await expect(page.getByText('Readiness and trust signals')).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Refresh diagnostics' }),
		).toBeVisible();

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Backup' }).click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toBe('jira-timesheet-settings.json');
	});

	test('reports exposes controls, consistency, and snapshot exports', async ({
		page,
	}) => {
		await page.goto('/reports');
		await page.waitForLoadState('networkidle');

		await expect(
			page.getByText('Filter, share, and validate this view'),
		).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Run consistency check' }),
		).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Snapshot HTML' }),
		).toBeVisible();

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Snapshot MD' }).click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toContain('reports-snapshot-week-');
	});
});
