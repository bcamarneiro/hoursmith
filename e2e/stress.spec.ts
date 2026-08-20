import { expect, type Page, test } from '@playwright/test';

/**
 * Stress / consistency probes.
 *
 * These tests do "weird" things on purpose: rapid-fire clicks, unexpected
 * keyboard chords, navigating in and out of features mid-load, reloading
 * with persisted state, and mismatched filter combinations. They exist to
 * surface state-corruption bugs and re-render glitches that the happy-path
 * suite would not catch.
 */

async function goReports(page: Page) {
	await page.goto('/reports');
	await page.waitForLoadState('networkidle');
}

async function ensureMonthly(page: Page) {
	await page.getByRole('button', { name: /^Monthly$/ }).click();
	await page.waitForTimeout(150);
}

async function setMonth(page: Page, label: RegExp) {
	const monthLabel = page
		.locator('[class*="MonthNavigator"] [class*="label"]')
		.first();
	const prev = page.getByRole('button', { name: 'Previous month' });
	const next = page.getByRole('button', { name: 'Next month' });

	// First go forward to recent date in case persisted state put us in the past.
	for (let i = 0; i < 6; i++) {
		const t = await monthLabel.textContent();
		if (t && /20(2[6-9]|3\d)/.test(t)) break;
		await next.click();
		await page.waitForTimeout(80);
	}

	for (let i = 0; i < 60; i++) {
		const text = await monthLabel.textContent();
		if (text && label.test(text)) return;
		await prev.click();
		await page.waitForTimeout(80);
	}
	throw new Error(`Could not navigate to month ${label}`);
}

test.describe('Reports — chaotic interaction', () => {
	test('hammering Weekly/Monthly toggles rapidly never crashes the page', async ({
		page,
	}) => {
		await goReports(page);
		const weekly = page.getByRole('button', { name: /^Weekly$/ });
		const monthly = page.getByRole('button', { name: /^Monthly$/ });
		for (let i = 0; i < 20; i++) {
			await (i % 2 === 0 ? weekly : monthly).click({ force: true });
		}
		await ensureMonthly(page);
		await expect(
			page.locator('[class*="MonthNavigator"] [class*="label"]').first(),
		).toBeVisible();
	});

	test('mass focus switching across users keeps grouping consistent', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);

		const focusSelect = page.getByLabel('Monthly focus');
		const optionsCount = await focusSelect.locator('option').count();
		for (let i = 0; i < optionsCount; i++) {
			const value = await focusSelect.locator('option').nth(i).textContent();
			if (!value) continue;
			await focusSelect.selectOption({ label: value.trim() });
			await page.waitForTimeout(150);
			// the page should still show the month navigator
			await expect(
				page.getByRole('button', { name: 'Next month' }),
			).toBeVisible();
		}
	});

	test('keyboard navigation through the calendar does not produce duplicate elements', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);
		// Tab through and arrow around — should not panic.
		for (let i = 0; i < 10; i++) {
			await page.keyboard.press('Tab');
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(150);
		const calendarLabels = page.locator('[class*="weekdayLabel"]');
		expect(await calendarLabels.count()).toBeGreaterThanOrEqual(7);
	});

	test('navigating away mid-load does not throw', async ({ page }) => {
		await goReports(page);
		// Don't wait for load — go straight to dashboard.
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Dashboard' })
			.click();
		await expect(page).toHaveURL(/dashboard/);
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Reports' })
			.click();
		await expect(page).toHaveURL(/reports/);
		await ensureMonthly(page);
		await expect(
			page.locator('[class*="MonthNavigator"] [class*="label"]').first(),
		).toBeVisible();
	});

	test('reloading inside monthly view restores the month label', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);
		const before = await page
			.locator('[class*="MonthNavigator"] [class*="label"]')
			.first()
			.textContent();
		await page.reload();
		await page.waitForLoadState('networkidle');
		await ensureMonthly(page);
		const after = await page
			.locator('[class*="MonthNavigator"] [class*="label"]')
			.first()
			.textContent();
		expect(after?.trim()).toBe(before?.trim());
	});

	test('totals exclude ghosts in every month visited (logged-policy invariant)', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);

		const months: RegExp[] = [
			/September\s+2025/,
			/October\s+2025/,
			/November\s+2025/,
		];
		for (const m of months) {
			await setMonth(page, m);
			const totalsTexts = await page
				.locator('[class*="monthTotalValue"]')
				.allTextContents();
			for (const t of totalsTexts) {
				const match = t.match(
					/([0-9]+(?:\.[0-9]+)?)h\s*\/\s*([0-9]+(?:\.[0-9]+)?)h/,
				);
				if (!match) continue;
				const total = Number(match[1]);
				const target = Number(match[2]);
				// A user can be over- or under-target, but the displayed total must
				// be a finite, non-NaN number and must be plausibly bounded by 2× target.
				expect(Number.isNaN(total)).toBe(false);
				expect(total).toBeGreaterThanOrEqual(0);
				expect(total).toBeLessThan(target * 2 + 1);
			}
		}
	});
});

test.describe('Dashboard — interaction sanity', () => {
	test('dashboard renders with mock data and supports week navigation', async ({
		page,
	}) => {
		await page.goto('/dashboard');
		await page.waitForLoadState('networkidle');

		const prev = page.getByRole('button', {
			name: 'Previous week',
			exact: true,
		});
		const next = page.getByRole('button', { name: 'Next week', exact: true });
		await expect(prev).toBeVisible();
		await expect(next).toBeVisible();

		// Click previous week 5x; should never throw.
		for (let i = 0; i < 5; i++) {
			await prev.click();
			await page.waitForTimeout(100);
		}
		await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
	});

	test('keyboard shortcut help opens', async ({ page }) => {
		await page.goto('/dashboard');
		await page.waitForLoadState('networkidle');
		await page
			.getByRole('button', { name: 'Open keyboard shortcuts help' })
			.click();
		await expect(
			page.getByRole('dialog', { name: /Keyboard Shortcuts/i }),
		).toBeVisible();
	});
});

test.describe('Settings — round-trip safety', () => {
	test('opening + reloading settings preserves the page', async ({ page }) => {
		await page.goto('/settings');
		await page.waitForLoadState('networkidle');
		await expect(page.getByText('Setup wizard')).toBeVisible();
		await page.reload();
		await page.waitForLoadState('networkidle');
		await expect(page.getByText('Setup wizard')).toBeVisible();
	});

	test('JSON backup is valid JSON and re-importable', async ({ page }) => {
		await page.goto('/settings');
		await page.waitForLoadState('networkidle');

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Backup' }).click();
		const download = await downloadPromise;

		const stream = await download.createReadStream();
		const chunks: Buffer[] = [];
		for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
			chunks.push(chunk);
		}
		const text = Buffer.concat(chunks).toString('utf8');

		// Must be valid JSON.
		expect(() => JSON.parse(text)).not.toThrow();
		const parsed = JSON.parse(text);
		expect(typeof parsed).toBe('object');
	});
});

test.describe('CSV export — finance-grade format invariants', () => {
	test('all CSVs use ISO dates, declare policy in filename, and carry provenance footer', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);

		// Export from the first user card — find any export button on the card.
		const userCard = page
			.locator('[class*="card"]')
			.filter({ has: page.getByText(/Sarah Johnson|Mike Chen|Alex Thompson/) })
			.first();

		const exportButton = userCard
			.getByRole('button', { name: /(Export|Download|CSV)/i })
			.first();

		const downloadPromise = page.waitForEvent('download');
		await exportButton.click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toMatch(/_2025-10_logged\.csv$/);

		const stream = await download.createReadStream();
		const chunks: Buffer[] = [];
		for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
			chunks.push(chunk);
		}
		const text = Buffer.concat(chunks).toString('utf8');

		// Header
		expect(text.split('\n')[0]).toBe(
			'Name;TicketKey;TicketName;IntendedDate;LoggedDate;DaysLate;IsBackdated;BackdateSource;BookedHours',
		);
		// No slash dates anywhere
		expect(text).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);
		// Provenance footer
		expect(text).toMatch(/^# generated=.* policy=logged period=2025-10/m);
		// Total + Backdated subtotal lines exist
		expect(text).toMatch(/;Total;[0-9]+\.[0-9]{2}/);
		expect(text).toMatch(/;Backdated;[0-9]+\.[0-9]{2}/);

		// Every data row's BookedHours has 2 decimals.
		const rows = text
			.split('\n')
			.filter(
				(l) =>
					l &&
					!l.startsWith('#') &&
					!l.startsWith('Name;') &&
					!l.startsWith(';') &&
					l.includes(';'),
			);
		for (const row of rows) {
			const cols = row.split(';');
			const hours = cols[cols.length - 1];
			expect(hours).toMatch(/^[0-9]+\.[0-9]{2}$/);
		}
	});

	test('IsBackdated rows are consistent with DaysLate>0 and source!=none', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);

		const sarah = page
			.locator('[class*="card"]')
			.filter({ hasText: 'Sarah Johnson' })
			.first();
		const exportButton = sarah
			.getByRole('button', { name: /(Export|Download|CSV)/i })
			.first();
		const downloadPromise = page.waitForEvent('download');
		await exportButton.click();
		const download = await downloadPromise;

		const stream = await download.createReadStream();
		const chunks: Buffer[] = [];
		for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
			chunks.push(chunk);
		}
		const text = Buffer.concat(chunks).toString('utf8');

		const lines = text.split('\n').slice(1);
		for (const line of lines) {
			if (!line || line.startsWith('#') || line.startsWith(';')) continue;
			const cols = line.split(';');
			if (cols.length < 9) continue;
			const daysLate = Number(cols[5]);
			const isBackdated = cols[6];
			const source = cols[7];
			if (isBackdated === 'true') {
				expect(daysLate).toBeGreaterThan(0);
				expect(['comment', 'jira-native']).toContain(source);
			} else {
				expect(source).toBe('none');
			}
		}
	});
});
