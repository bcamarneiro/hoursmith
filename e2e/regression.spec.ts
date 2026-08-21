import { expect, test } from '@playwright/test';
import { openSettingsSection } from './helpers/settings';

async function duplicateIds(page: import('@playwright/test').Page) {
	return page.evaluate(() =>
		Array.from(
			new Set(
				Array.from(document.querySelectorAll('[id]'))
					.map((node) => node.id)
					.filter((id, index, ids) => id && ids.indexOf(id) !== index),
			),
		),
	);
}

async function hasHorizontalOverflow(page: import('@playwright/test').Page) {
	return page.evaluate(
		() => document.body.scrollWidth > document.documentElement.clientWidth + 2,
	);
}

test.describe('Regression guardrails', () => {
	test('core pages do not emit console or page errors', async ({ page }) => {
		const consoleErrors: string[] = [];
		const pageErrors: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});
		page.on('pageerror', (error) => pageErrors.push(error.message));

		for (const path of ['/', '/settings', '/dashboard', '/reports']) {
			await page.goto(path);
			await page.waitForLoadState('networkidle');
		}

		expect(consoleErrors).toEqual([]);
		expect(pageErrors).toEqual([]);
	});

	test('settings keeps proxy, team, and time-off decisions explicit', async ({
		page,
	}) => {
		await page.goto('/settings');
		await page.waitForLoadState('networkidle');

		// The Settings redesign split these three decisions across rail
		// sections: the proxy copy stays in Connection (the section the page
		// opens on), Team Members moved to Reports Scope, and the time-off
		// calendars moved to Services.
		await expect(
			page.getByRole('heading', { name: 'Try direct browser access first' }),
		).toBeVisible();

		await openSettingsSection(page, 'Reports Scope');
		await expect(page.getByLabel(/Team Members/)).toBeVisible();

		await openSettingsSection(page, 'Services');
		await expect(
			page.getByRole('heading', { name: 'Time off calendars', exact: true }),
		).toBeVisible();

		await page.getByRole('button', { name: '+ Time off calendar' }).click();
		await page
			.getByLabel('Attribution mode for time off calendar')
			.selectOption('shared');

		// Shared time-off calendars no longer attribute via the Team Members
		// list; commit 47e6809 replaced that with explicit AbsenceAssignment
		// rules, and the hint shown for "shared" changed to match.
		await expect(
			page.getByText(
				'Shared calendars use the assignment rules below to match event titles to the right teammate.',
			),
		).toBeVisible();
	});

	test('key pages do not render duplicate ids', async ({ page }) => {
		for (const path of ['/settings', '/dashboard', '/reports']) {
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			expect(await duplicateIds(page), path).toEqual([]);
		}

		await page.getByRole('button', { name: 'Monthly' }).click();
		await page.waitForLoadState('networkidle');
		expect(await duplicateIds(page), 'monthly reports').toEqual([]);
	});

	test('mobile dashboard and monthly reports avoid page-level horizontal overflow', async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });

		await page.goto('/dashboard');
		await page.waitForLoadState('networkidle');
		await expect.poll(() => hasHorizontalOverflow(page)).toBe(false);

		await page.goto('/reports');
		await page.waitForLoadState('networkidle');
		await page.getByRole('button', { name: 'Monthly' }).click();
		await page.waitForLoadState('networkidle');
		await expect.poll(() => hasHorizontalOverflow(page)).toBe(false);
	});

	test('reports explains attention and manager mode controls', async ({
		page,
	}) => {
		await page.goto('/reports');
		await page.waitForLoadState('networkidle');

		await expect(page.getByText('Needs attention only')).toBeVisible();
		await expect(
			page.getByText('Show only people who still have a gap this week.'),
		).toBeVisible();
		await expect(page.getByText('Manager mode')).toBeVisible();
		await expect(
			page.getByText(
				'Add multi-week compliance trends and recurring-gap signals.',
			),
		).toBeVisible();
	});
});
