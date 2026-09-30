import { expect, type Page, test } from '@playwright/test';
import { openSettingsSection } from './helpers/settings';

/**
 * Timesheet CSV column layout, as emitted by `buildTimesheetCsv` with the
 * absence columns switched on (which is what the Reports per-user export
 * uses):
 *
 *   Name;TicketKey;TicketName;IntendedDate;LoggedDate;IsBackdated;BookedHours;
 *   IsAbsence;AbsenceKind
 *
 * `DaysLate` and `BackdateSource` were removed on purpose in 23dc12a, so the
 * last column is no longer BookedHours — indices are named here rather than
 * counted from the end.
 */
const COL = {
	intendedDate: 3,
	loggedDate: 4,
	isBackdated: 5,
	bookedHours: 6,
} as const;

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
			.getByRole('link', { name: 'My Week' })
			.click();
		await expect(page).toHaveURL(/my-week/);
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
		// The old standalone "Setup wizard" panel was merged with DiagnosticsPanel
		// into the single readiness header at the top of Settings; its kicker is
		// the stable landmark that survives the merge.
		await expect(page.getByText('Setup & readiness')).toBeVisible();
		await page.reload();
		await page.waitForLoadState('networkidle');
		await expect(page.getByText('Setup & readiness')).toBeVisible();
	});

	test('JSON backup is valid JSON and re-importable', async ({ page }) => {
		await page.goto('/settings');
		await page.waitForLoadState('networkidle');

		// Behind the left rail the Backup button only becomes clickable once its
		// section is revealed, and "Backup" also substring-matches the rail item
		// "Data & backup" — hence the exact match.
		await openSettingsSection(page, 'Data & backup');
		// Two Backup buttons exist (the section's own, and the persistent sticky
		// save bar's) and "Backup" also substring-matches the rail item
		// "Data & backup" — so scope to the section and match exactly.
		const dataSection = page
			.locator('section')
			.filter({ has: page.getByRole('heading', { name: 'Data & backup' }) })
			.first();

		const downloadPromise = page.waitForEvent('download');
		await dataSection
			.getByRole('button', { name: 'Backup', exact: true })
			.click();
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

/**
 * The provenance footer is now the opt-in preference "Add a provenance footer
 * to CSV exports" (Settings → Preferences), off by default so exports don't
 * expose the Jira host or build version. A test that wants to assert the
 * footer's format has to switch it on first — asserting it unconditionally
 * would only be asserting today's default value.
 *
 * The navigation here has to stay client-side: `frontend/main.tsx` re-seeds the
 * whole config from `createDefaultConfig()` on every full page load in offline
 * mode, so a `page.goto` after saving would silently reset the toggle.
 */
async function enableCsvProvenanceViaSettings(page: Page) {
	const nav = page.getByRole('navigation', { name: 'Primary' });
	await nav.getByRole('link', { name: 'Settings' }).click();
	await expect(page).toHaveURL(/settings/);
	await openSettingsSection(page, 'Preferences');
	const toggle = page.getByLabel('Add a provenance footer to CSV exports');
	if (!(await toggle.isChecked())) await toggle.check();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(toggle).toBeChecked();
	await nav.getByRole('link', { name: 'Reports' }).click();
	await expect(page).toHaveURL(/reports/);
}

test.describe('CSV export — finance-grade format invariants', () => {
	test('all CSVs use ISO dates, declare policy in filename, and carry provenance footer', async ({
		page,
	}) => {
		await goReports(page);
		await enableCsvProvenanceViaSettings(page);
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

		// Header. 23dc12a dropped DaysLate and BackdateSource on purpose; the
		// per-user Reports export additionally carries the absence column pair.
		expect(text.split('\n')[0]).toBe(
			'Name;TicketKey;TicketName;IntendedDate;LoggedDate;IsBackdated;BookedHours;IsAbsence;AbsenceKind',
		);
		// No slash dates anywhere
		expect(text).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);
		// Provenance footer
		expect(text).toMatch(/^# generated=.* policy=logged period=2025-10/m);
		// All three subtotal lines exist (Backdated / Non-backdated / Total).
		expect(text).toMatch(/;Total;[0-9]+\.[0-9]{2}/);
		expect(text).toMatch(/;Backdated;[0-9]+\.[0-9]{2}/);
		expect(text).toMatch(/;Non-backdated;[0-9]+\.[0-9]{2}/);

		// Every data row's BookedHours has 2 decimals. BookedHours is no longer
		// the last column, so it is addressed by index.
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
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			const cols = row.split(';');
			expect(cols[COL.bookedHours]).toMatch(/^[0-9]+\.[0-9]{2}$/);
		}
	});

	// RE-EXPRESSED (23dc12a): the CSV no longer carries DaysLate or
	// BackdateSource, so the original "IsBackdated ⇒ DaysLate>0 and
	// source!='none'" wording is unwriteable against the current format. Both
	// dropped columns were derived from the two date columns that remain:
	// `classifyWorklog` only moves LoggedDate away from IntendedDate when it
	// assigns a source ('comment' or 'jira-native'), and DaysLate is exactly
	// max(0, LoggedDate - IntendedDate). So the same invariant, stated in the
	// surviving columns, is the strict biconditional below — no weaker than
	// before, just spelled with the columns that still exist.
	test('IsBackdated is exactly "LoggedDate is later than IntendedDate"', async ({
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
		let inspected = 0;
		let backdatedSeen = 0;
		for (const line of lines) {
			if (!line || line.startsWith('#') || line.startsWith(';')) continue;
			const cols = line.split(';');
			if (cols.length < 9) continue;
			const intended = cols[COL.intendedDate];
			const logged = cols[COL.loggedDate];
			const isBackdated = cols[COL.isBackdated];
			expect(intended).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(logged).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(['true', 'false']).toContain(isBackdated);
			inspected += 1;
			// ISO dates compare correctly as strings.
			if (isBackdated === 'true') {
				backdatedSeen += 1;
				expect(logged > intended).toBe(true);
			} else {
				expect(logged > intended).toBe(false);
			}
		}
		expect(inspected).toBeGreaterThan(0);
		// Sarah is the fixture's backdating user — if no row is tagged, the
		// classifier stopped seeing her backdates and the check above is vacuous.
		expect(backdatedSeen).toBeGreaterThan(0);
	});
});
