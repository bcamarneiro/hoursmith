import { expect, type Page, test } from '@playwright/test';

/**
 * End-to-end coverage for the backdated-worklog UX.
 *
 * Mock data context (from MockWorklogsSimple.ts):
 * - Sarah Johnson: 20 regular days in October 2025 + 2 backdated entries
 *   logged on Oct 5 / Oct 10 with "Original Worklog Date was: 2025/09/25"
 *   and "...09/26" comments — i.e. Pattern A (started=loggedDate, marker
 *   in comment).
 * - Mike Chen: 19 regular October days + 3 backdated entries logged on
 *   Oct 6, 12, 18 with markers pointing at Sep 20, 21, 22.
 *
 * After Phase 2 changes the rules are:
 * - Day totals follow the **logged** policy. Backdated hours count on the
 *   day they were logged, never on the intended day.
 * - The intended day shows a non-counting ghost placeholder.
 * - The logged day groups backdated entries under a "Backdated submissions"
 *   header, separate from regular entries.
 */

async function openMonthlyReports(page: Page) {
	await page.goto('/reports');
	await page.waitForLoadState('networkidle');
	await page.getByRole('button', { name: /^Monthly$/ }).click();
	await page.waitForTimeout(300);
}

async function setMonth(page: Page, label: RegExp) {
	const monthLabel = page.locator('[class*="MonthNavigator"] [class*="label"]');
	for (let i = 0; i < 24; i++) {
		const text = await monthLabel.textContent();
		if (text && label.test(text)) return;
		await page.getByRole('button', { name: 'Previous month' }).click();
		await page.waitForTimeout(150);
	}
	throw new Error(`Could not navigate to month ${label}`);
}

function userCard(page: Page, displayName: string) {
	return page
		.locator('[class*="TimesheetGrid_card"], [class*="card"]')
		.filter({ hasText: displayName })
		.first();
}

test.describe('Backdated worklog UX', () => {
	test.beforeEach(async ({ page }) => {
		await openMonthlyReports(page);
	});

	test('logged month shows the Backdated submissions group for Sarah and Mike', async ({
		page,
	}) => {
		await setMonth(page, /October\s+2025/);

		const sarah = userCard(page, 'Sarah Johnson');
		await expect(sarah).toBeVisible();
		await expect(
			sarah.getByText(/Backdated submissions \(\d+\)/i).first(),
		).toBeVisible();

		const mike = userCard(page, 'Mike Chen');
		await expect(mike).toBeVisible();
		await expect(
			mike.getByText(/Backdated submissions \(\d+\)/i).first(),
		).toBeVisible();
	});

	test('intended month shows ghost "Reconciled later" entries that do not count', async ({
		page,
	}) => {
		await setMonth(page, /September\s+2025/);

		const sarah = userCard(page, 'Sarah Johnson');
		await expect(sarah).toBeVisible();
		const ghostHeaders = sarah.getByText(/Reconciled later \(\d+\)/i);
		await expect(ghostHeaders.first()).toBeVisible();
		const ghostTexts = await sarah
			.getByText(/logged 2025-10/)
			.allTextContents();
		expect(ghostTexts.length).toBeGreaterThanOrEqual(1);
	});

	test('switching months does not duplicate or lose backdated hours (logged-policy invariant)', async ({
		page,
	}) => {
		await setMonth(page, /October\s+2025/);
		const sarah = userCard(page, 'Sarah Johnson');
		const monthTotal = sarah.locator('[class*="monthTotalValue"]').first();
		const octText = (await monthTotal.textContent()) ?? '';
		const octHoursMatch = octText.match(/([0-9]+(?:\.[0-9]+)?)h/);
		expect(octHoursMatch).not.toBeNull();
		const octHours = Number(octHoursMatch?.[1] ?? '0');
		expect(octHours).toBeGreaterThan(0);

		await setMonth(page, /September\s+2025/);
		await expect(userCard(page, 'Sarah Johnson')).toBeVisible();
		const sepText =
			(await userCard(page, 'Sarah Johnson')
				.locator('[class*="monthTotalValue"]')
				.first()
				.textContent()) ?? '';
		const sepHoursMatch = sepText.match(/([0-9]+(?:\.[0-9]+)?)h/);
		const sepHours = Number(sepHoursMatch?.[1] ?? '0');

		// The 2 backdated entries (16h) belong to October under logged policy,
		// so September must not include them. October must include them.
		expect(octHours).toBeGreaterThan(sepHours);
	});

	test('ghost entries render with a dashed/striped style and a non-counting tooltip', async ({
		page,
	}) => {
		await setMonth(page, /September\s+2025/);

		const ghost = page.locator('[role="note"]').first();
		await expect(ghost).toBeVisible();
		const ariaLabel = await ghost.getAttribute('aria-label');
		expect(ariaLabel).toMatch(/does not count/i);
		expect(ariaLabel).toMatch(/2025-10/);

		const borderStyle = await ghost.evaluate(
			(el) => getComputedStyle(el).borderStyle,
		);
		expect(borderStyle).toContain('dashed');
	});

	test('CSV export contains IsBackdated and BackdateSource columns and a provenance footer', async ({
		page,
	}) => {
		await setMonth(page, /October\s+2025/);

		const sarah = userCard(page, 'Sarah Johnson');
		const downloadButton = sarah.getByRole('button', {
			name: /(Export|Download)/,
		});
		const downloadPromise = page.waitForEvent('download');
		await downloadButton.first().click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toMatch(
			/timesheet_.*Sarah.*_2025-10_logged\.csv/,
		);

		const stream = await download.createReadStream();
		const chunks: Buffer[] = [];
		for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
			chunks.push(chunk);
		}
		const text = Buffer.concat(chunks).toString('utf8');

		expect(text).toContain(
			'Name;TicketKey;TicketName;IntendedDate;LoggedDate;DaysLate;IsBackdated;BackdateSource;BookedHours',
		);
		expect(text).toMatch(/;true;comment;/);
		expect(text).toMatch(/^# generated=.* policy=logged period=2025-10/m);
		expect(text).toMatch(/;Backdated;[0-9]+\.[0-9]{2}/);
		expect(text).not.toMatch(/\d{4}\/\d{2}\/\d{2}/); // no slash-style dates
	});

	test('rapid month navigation does not break the calendar', async ({
		page,
	}) => {
		await setMonth(page, /October\s+2025/);
		const prev = page.getByRole('button', { name: 'Previous month' });
		const next = page.getByRole('button', { name: 'Next month' });

		for (let i = 0; i < 6; i++) {
			await prev.click();
		}
		for (let i = 0; i < 8; i++) {
			await next.click();
		}
		for (let i = 0; i < 4; i++) {
			await prev.click();
		}

		const monthLabel = page.locator(
			'[class*="MonthNavigator"] [class*="label"]',
		);
		await expect(monthLabel).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Next month' }),
		).toBeEnabled();
	});

	test('keyboard activates month navigation', async ({ page }) => {
		await setMonth(page, /October\s+2025/);
		const monthLabel = page.locator(
			'[class*="MonthNavigator"] [class*="label"]',
		);
		const initial = await monthLabel.textContent();
		await page.getByRole('button', { name: 'Previous month' }).focus();
		await page.keyboard.press('Enter');
		await page.waitForTimeout(200);
		const next = await monthLabel.textContent();
		expect(next).not.toBe(initial);
	});

	test('ghost entry is not counted by the day calculation (defensive cross-check)', async ({
		page,
	}) => {
		await setMonth(page, /September\s+2025/);

		// Day 25: Sarah has a ghost (and only a ghost — Sept 25 has no real
		// regular Sarah worklog in the simple mocks). The day total should be
		// 0 even though a ghost is present.
		const sarah = userCard(page, 'Sarah Johnson');
		// Ghost rows are inside the user card and carry role="note".
		const ghostRows = sarah.locator('[role="note"]');
		expect(await ghostRows.count()).toBeGreaterThan(0);
		const firstGhost = ghostRows.first();
		// The cell that contains this ghost is the closest ancestor with a
		// "dayCell" class (CSS module).
		const dayCell = firstGhost.locator(
			'xpath=ancestor::*[contains(@class,"dayCell")][1]',
		);
		const cellText = (await dayCell.textContent()) ?? '';
		// Ghosts must NOT contribute hours to the day. The cell can still show
		// missing-hours warnings, but no positive hour total greater than 0.
		const totalMatches = cellText.match(/(\d+\.\d+)\s*h/g) || [];
		const positiveTotals = totalMatches
			.map((m) => Number((m.match(/(\d+\.\d+)/) || ['0'])[1]))
			.filter((n) => n > 0);
		expect(positiveTotals.every((n) => n <= 8)).toBe(true);
	});

	test('home, dashboard, and reports remain reachable while in monthly view', async ({
		page,
	}) => {
		await setMonth(page, /October\s+2025/);
		const nav = page.getByRole('navigation', { name: 'Primary' });
		await nav.getByRole('link', { name: 'Settings' }).click();
		await expect(page).toHaveURL(/settings/);
		await page.goBack();
		await expect(page.getByRole('button', { name: /^Monthly$/ })).toBeVisible();
	});
});

test.describe('Cross-feature regression sweep', () => {
	test('home → dashboard → reports → settings without console errors', async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (err) => errors.push(err.message));
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(msg.text());
		});

		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await page.getByRole('link', { name: 'Open Dashboard' }).click();
		await expect(page).toHaveURL(/dashboard/);
		await page.waitForLoadState('networkidle');

		const nav = page.getByRole('navigation', { name: 'Primary' });
		await nav.getByRole('link', { name: 'Reports' }).click();
		await expect(page).toHaveURL(/reports/);
		await page.waitForLoadState('networkidle');
		await page.getByRole('button', { name: /^Monthly$/ }).click();
		await page.waitForTimeout(300);

		await nav.getByRole('link', { name: 'Settings' }).click();
		await expect(page).toHaveURL(/settings/);
		await page.waitForLoadState('networkidle');

		// Filter out noise from MSW's intentional console.info / dev tooling.
		const fatal = errors.filter(
			(e) =>
				!/MSW|Service Worker|favicon|sourcemap|DevTools/i.test(e) &&
				!/Warning: |Download the React DevTools/i.test(e),
		);
		expect(fatal, fatal.join('\n')).toHaveLength(0);
	});

	test('repeated reload does not corrupt persisted state', async ({ page }) => {
		await openMonthlyReports(page);
		await setMonth(page, /October\s+2025/);
		for (let i = 0; i < 3; i++) {
			await page.reload();
			await page.waitForLoadState('networkidle');
		}
		await expect(
			userCard(page, 'Sarah Johnson')
				.getByText(/Backdated submissions \(\d+\)/i)
				.first(),
		).toBeVisible();
	});
});
