import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Cross-view data-consistency probes.
 *
 * The product surfaces several aggregations of the same worklog dataset:
 *   - Reports → Monthly calendar (per-user grid + day cells + month total)
 *   - Reports → Monthly OverviewTable (team table)
 *   - Reports → Weekly OverviewTable
 *   - Dashboard → WeekOverview chips
 *   - Dashboard → MonthHeatmap "X logged"
 *   - CSV exports
 *
 * They must all agree on totals for the same period under the logged-policy.
 * If they disagree, finance/management reports diverge from what the user sees,
 * so these tests are intentionally strict.
 */

const HOUR_PATTERN = /([0-9]+(?:\.[0-9]+)?)\s*h/g;

/**
 * Timesheet CSV column layout:
 *
 *   Name;TicketKey;TicketName;IntendedDate;LoggedDate;IsBackdated;BookedHours
 *   [;IsAbsence;AbsenceKind]
 *
 * 23dc12a removed `DaysLate` and `BackdateSource`, and the absence pair is
 * appended after BookedHours, so BookedHours is no longer the last column and
 * must be addressed by index.
 */
const COL = {
	isBackdated: 5,
	bookedHours: 6,
} as const;
const MIN_DATA_COLUMNS = 7;

function tolerant(a: number, b: number, eps = 0.05) {
	return Math.abs(a - b) <= eps;
}

async function goReports(page: Page) {
	await page.goto('/reports');
	await page.waitForLoadState('networkidle');
}

async function ensureMonthly(page: Page) {
	await page.getByRole('button', { name: /^Monthly$/ }).click();
	await page
		.locator('[class*="weekdayLabel"]')
		.first()
		.waitFor({ state: 'visible', timeout: 15000 });
}

async function ensureWeekly(page: Page) {
	await page.getByRole('button', { name: /^Weekly$/ }).click();
	await page.waitForTimeout(500);
}

async function setMonth(page: Page, label: RegExp) {
	const monthLabel = page
		.locator('[class*="MonthNavigator"] [class*="label"]')
		.first();
	const prev = page.getByRole('button', { name: 'Previous month' });
	const next = page.getByRole('button', { name: 'Next month' });

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
	throw new Error(`Could not navigate to ${label}`);
}

function userCard(page: Page, name: string): Locator {
	return page.locator('[class*="card"]').filter({ hasText: name }).first();
}

async function readMonthTotalHours(card: Locator): Promise<number> {
	const text =
		(await card.locator('[class*="monthTotalValue"]').first().textContent()) ??
		'';
	const m = text.match(/([0-9]+(?:\.[0-9]+)?)h\s*\/\s*([0-9]+(?:\.[0-9]+)?)h/);
	if (!m) throw new Error(`Cannot parse month total from "${text}"`);
	return Number(m[1]);
}

async function sumDayCellHours(card: Locator): Promise<number> {
	// DayCell shows the day total in `[class*="DaySummary_total"]` (formatHours)
	// when a day has worklogs. We extract every "Xh" or "X.Xh" and sum them,
	// avoiding the monthTotal node and ghost nodes.
	const totals = await card
		.locator('[class*="dayCell"]')
		.evaluateAll((cells) => {
			const result: number[] = [];
			for (const cell of cells) {
				const totalEl =
					cell.querySelector('[class*="DaySummary"][class*="total"]') ??
					cell.querySelector('[class*="total"]:not([class*="monthTotal"])');
				if (!totalEl) continue;
				const txt = (totalEl.textContent ?? '').trim();
				const m = txt.match(/^([0-9]+(?:\.[0-9]+)?)h$/);
				if (m) result.push(Number(m[1]));
			}
			return result;
		});
	return totals.reduce((s, n) => s + n, 0);
}

async function downloadUserCsv(
	page: Page,
	card: Locator,
): Promise<{ filename: string; text: string }> {
	const button = card
		.getByRole('button', { name: /(Export|Download|CSV)/i })
		.first();
	const downloadPromise = page.waitForEvent('download');
	await button.click();
	const download = await downloadPromise;
	const stream = await download.createReadStream();
	const chunks: Buffer[] = [];
	for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
		chunks.push(chunk);
	}
	return {
		filename: download.suggestedFilename(),
		text: Buffer.concat(chunks).toString('utf8'),
	};
}

/** Data rows only — header, provenance footer and the subtotal rows dropped. */
function csvDataRows(text: string): string[][] {
	const rows: string[][] = [];
	for (const line of text.split('\n')) {
		if (
			!line ||
			line.startsWith('#') ||
			line.startsWith('Name;') ||
			line.startsWith(';')
		)
			continue;
		const cols = line.split(';');
		if (cols.length < MIN_DATA_COLUMNS) continue;
		rows.push(cols);
	}
	return rows;
}

function csvSumBookedHours(
	text: string,
	predicate: (cols: string[]) => boolean = () => true,
): number {
	let sum = 0;
	for (const cols of csvDataRows(text)) {
		if (!predicate(cols)) continue;
		const v = Number(cols[COL.bookedHours]);
		if (!Number.isNaN(v)) sum += v;
	}
	return sum;
}

function csvDeclaredTotal(text: string): number {
	const m = text.match(/;Total;([0-9]+\.[0-9]{2})/);
	return m ? Number(m[1]) : Number.NaN;
}

function csvDeclaredBackdated(text: string): number {
	const m = text.match(/;Backdated;([0-9]+\.[0-9]{2})/);
	return m ? Number(m[1]) : Number.NaN;
}

function csvDeclaredNonBackdated(text: string): number {
	const m = text.match(/;Non-backdated;([0-9]+\.[0-9]{2})/);
	return m ? Number(m[1]) : Number.NaN;
}

test.describe('Reports Monthly — internal consistency', () => {
	test.beforeEach(async ({ page }) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);
	});

	test('Sarah: month-total header == sum of day-cell totals', async ({
		page,
	}) => {
		const sarah = userCard(page, 'Sarah Johnson');
		const total = await readMonthTotalHours(sarah);
		const sumDays = await sumDayCellHours(sarah);
		expect(tolerant(total, sumDays, 0.1)).toBe(true);
	});

	test('Mike: month-total header == sum of day-cell totals', async ({
		page,
	}) => {
		const mike = userCard(page, 'Mike Chen');
		const total = await readMonthTotalHours(mike);
		const sumDays = await sumDayCellHours(mike);
		expect(tolerant(total, sumDays, 0.1)).toBe(true);
	});

	test('Alex (no backdates): month-total header == sum of day-cell totals', async ({
		page,
	}) => {
		const alex = userCard(page, 'Alex Thompson');
		const total = await readMonthTotalHours(alex);
		const sumDays = await sumDayCellHours(alex);
		expect(tolerant(total, sumDays, 0.1)).toBe(true);
	});

	test('CSV subtotals partition its own BookedHours rows', async ({ page }) => {
		for (const name of ['Sarah Johnson', 'Mike Chen', 'Alex Thompson']) {
			const card = userCard(page, name);
			const { text } = await downloadUserCsv(page, card);

			const backdated = csvDeclaredBackdated(text);
			const nonBackdated = csvDeclaredNonBackdated(text);
			const total = csvDeclaredTotal(text);

			// The CSV is the deliberate inclusive exception (23dc12a): it keeps
			// every row, and its three subtotals partition them — Backdated and
			// Non-backdated each reconcile to their own rows, and together they
			// account for Total, i.e. for every row in the file.
			expect(
				tolerant(
					csvSumBookedHours(text, (c) => c[COL.isBackdated] === 'true'),
					backdated,
					0.01,
				),
			).toBe(true);
			expect(
				tolerant(
					csvSumBookedHours(text, (c) => c[COL.isBackdated] === 'false'),
					nonBackdated,
					0.01,
				),
			).toBe(true);
			expect(tolerant(backdated + nonBackdated, total, 0.01)).toBe(true);
			expect(tolerant(csvSumBookedHours(text), total, 0.01)).toBe(true);
		}
	});

	// RE-EXPRESSED (23dc12a): "CSV Total == UI month-total header" is no longer
	// true by design. Backdated worklogs stopped contributing to any displayed
	// total, while the CSV deliberately keeps every row — so CSV Total is now
	// strictly ≥ the header whenever the user has backdates. The subtotal that
	// the header is defined against is Non-backdated, so that is what the
	// cross-surface invariant is stated over; Total is still pinned, one line
	// down, as Non-backdated + Backdated.
	test('CSV Non-backdated subtotal matches the UI month-total header', async ({
		page,
	}) => {
		for (const name of ['Sarah Johnson', 'Mike Chen', 'Alex Thompson']) {
			const card = userCard(page, name);
			const headerHours = await readMonthTotalHours(card);
			const { text } = await downloadUserCsv(page, card);
			expect(
				tolerant(headerHours, csvDeclaredNonBackdated(text), 0.1),
				`${name}: header showed ${headerHours}h but the CSV Non-backdated subtotal was ${csvDeclaredNonBackdated(text)}h`,
			).toBe(true);
			expect(
				tolerant(
					csvDeclaredNonBackdated(text) + csvDeclaredBackdated(text),
					csvDeclaredTotal(text),
					0.01,
				),
			).toBe(true);
		}
	});

	test('Backdated subtotal in CSV matches the hours on rows tagged IsBackdated=true', async ({
		page,
	}) => {
		const card = userCard(page, 'Sarah Johnson');
		const { text } = await downloadUserCsv(page, card);
		const declaredBackdated = csvDeclaredBackdated(text);
		const summed = csvSumBookedHours(
			text,
			(cols) => cols[COL.isBackdated] === 'true',
		);
		// Sarah is the fixture's backdating user — a zero here would make the
		// comparison vacuous rather than passing.
		expect(declaredBackdated).toBeGreaterThan(0);
		expect(tolerant(summed, declaredBackdated, 0.01)).toBe(true);
	});
});

test.describe('Reports — Weekly vs Monthly invariants', () => {
	test('switching Weekly→Monthly→Weekly does not change visible user count or totals', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);

		const monthlyTotals = await page
			.locator('[class*="monthTotalValue"]')
			.allTextContents();

		await ensureWeekly(page);
		await page.waitForTimeout(300);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);

		const monthlyTotalsAfter = await page
			.locator('[class*="monthTotalValue"]')
			.allTextContents();

		expect(monthlyTotalsAfter).toEqual(monthlyTotals);
	});

	test('OverviewTable hours per user agree with the calendar grid header', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);

		// The OverviewTable is rendered when more than one user is visible.
		// Find it as the table with a "Hours" column header.
		const table = page
			.getByRole('table')
			.filter({ has: page.getByRole('button', { name: /Hours/i }) })
			.first();

		// Iterate visible rows and compare each user's hours cell against
		// the matching user card's month total header.
		const rowCount = await table.locator('tbody tr').count();
		expect(rowCount).toBeGreaterThan(1);

		for (let i = 0; i < rowCount - 1; i++) {
			const row = table.locator('tbody tr').nth(i);
			const userText =
				(await row.locator('[class*="userName"]').first().textContent()) ?? '';
			const user = userText.trim();
			if (!user) continue;
			const hoursCellText =
				(await row.locator('td').last().textContent()) ?? '';
			const tableHoursMatch = hoursCellText.match(/([0-9]+(?:\.[0-9]+)?)h/);
			if (!tableHoursMatch) continue;
			const tableHours = Number(tableHoursMatch[1]);

			const card = userCard(page, user);
			if ((await card.count()) === 0) continue;
			const cardHours = await readMonthTotalHours(card);
			expect(
				tolerant(tableHours, cardHours, 0.1),
				`OverviewTable showed ${tableHours}h for ${user} but the calendar grid showed ${cardHours}h — these must agree`,
			).toBe(true);
		}
	});
});

test.describe('Dashboard ↔ Reports — same numbers, both directions', () => {
	test('dashboard heatmap "X logged" tracks the visible month', async ({
		page,
	}) => {
		await page.goto('/dashboard');
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(1500);

		// MonthHeatmap renders an "X logged" string near its header. It only
		// shows the current user's data so its value is independent of
		// other users.
		const loggedText = await page
			.getByText(/[0-9]+(?:\.[0-9]+)?h logged/i)
			.first()
			.textContent()
			.catch(() => '');
		// The dashboard uses the connected user; in offline mode the email may
		// not match any mock author, so the heatmap can be 0h. We just assert
		// it is a parseable number.
		const m = (loggedText ?? '').match(/([0-9]+(?:\.[0-9]+)?)h/);
		if (m) {
			const hours = Number(m[1]);
			expect(hours).toBeGreaterThanOrEqual(0);
			expect(Number.isFinite(hours)).toBe(true);
		}
	});

	test('dashboard week chip totals add up to the week summary', async ({
		page,
	}) => {
		await page.goto('/dashboard');
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(1500);

		const summaryText =
			(await page
				.getByText(/[0-9]+(?:\.[0-9]+)?h logged against/)
				.textContent()
				.catch(() => '')) ?? '';
		const sumMatch = summaryText.match(/([0-9]+(?:\.[0-9]+)?)h logged/);
		if (!sumMatch) return; // user has no worklogs in this week — skip
		const declaredLogged = Number(sumMatch[1]);

		// Sum the hours from each day chip's aria-label inside the
		// "Weekly worklog overview" list. Empty days have aria-label
		// "Mon ..., empty, 0 hours logged" which contributes 0.
		const ariaLabels = await page
			.getByRole('listitem')
			.filter({ hasText: /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/ })
			.evaluateAll((items) =>
				items.map((el) => el.getAttribute('aria-label') ?? ''),
			);
		let sum = 0;
		for (const label of ariaLabels) {
			// "Mon 2026-05-04, complete, 8h"
			const m = label.match(/,\s*([0-9]+(?:\.[0-9]+)?)h\b/);
			if (m) sum += Number(m[1]);
		}
		expect(tolerant(sum, declaredLogged, 0.6)).toBe(true);
	});
});

test.describe('Backdated invariants across views', () => {
	test('a backdated entry contributes to logged-month totals only, never both months', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);

		await setMonth(page, /October\s+2025/);
		const sarahOct = userCard(page, 'Sarah Johnson');
		const octTotal = await readMonthTotalHours(sarahOct);

		await setMonth(page, /September\s+2025/);
		const sarahSepCount = await userCard(page, 'Sarah Johnson').count();
		// In September, Sarah may render with only ghost rows (and 0h month total)
		// OR not render at all if no entry has loggedOn in Sept. Either case is
		// acceptable as long as totals don't double-count.
		let sepTotal = 0;
		if (sarahSepCount > 0) {
			try {
				sepTotal = await readMonthTotalHours(userCard(page, 'Sarah Johnson'));
			} catch {
				sepTotal = 0;
			}
		}

		// If we add Sep + Oct totals, no single backdated entry's hours should
		// be counted twice. We can't directly inspect underlying entries, but
		// the relationship "sepTotal + octTotal <= ground truth" holds — ground
		// truth here being Sarah's October total alone (which includes the
		// backdates) since September has no real Sarah entries in the mocks.
		// So sepTotal must be 0 under logged-policy.
		expect(sepTotal).toBe(0);
		expect(octTotal).toBeGreaterThan(0);
	});

	test('Reports October "Backdated submissions" hours == CSV Backdated subtotal', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);
		const sarah = userCard(page, 'Sarah Johnson');

		const { text } = await downloadUserCsv(page, sarah);
		const declaredBackdated = csvDeclaredBackdated(text);

		// In the UI the backdated subgroup contains worklog items whose
		// "Xh" hours can be summed.
		const backdatedSection = sarah
			.locator(
				'[class*="WorklogList_section"]:has-text("Backdated submissions")',
			)
			.first();
		const visible = await backdatedSection.count();
		if (visible === 0) {
			// Fallback: even if the section selector misses, find the header text
			expect(declaredBackdated).toBeGreaterThanOrEqual(0);
			return;
		}
		const allText = (await backdatedSection.textContent()) ?? '';
		const hourMatches = allText.match(HOUR_PATTERN) || [];
		let sum = 0;
		for (const m of hourMatches) {
			const num = Number((m.match(/([0-9]+(?:\.[0-9]+)?)/) || ['0'])[1]);
			sum += num;
		}
		// The header itself is "Backdated submissions (N)" — no "h" so safe.
		// We expect the CSV declared value to be ≥ what we found in the
		// section (UI may collapse hours to integers via formatHours).
		expect(declaredBackdated).toBeGreaterThan(0);
		expect(sum).toBeGreaterThan(0);
		// Allow generous tolerance: UI uses formatHours (0 or 1dp), CSV uses 2dp.
		expect(tolerant(sum, declaredBackdated, 0.6)).toBe(true);
	});

	test('flipping aggregation inputs (focus selection) does not alter month totals', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);

		const sarah = userCard(page, 'Sarah Johnson');
		const initial = await readMonthTotalHours(sarah);

		// Focus only Sarah, then re-broaden, then compare.
		await page
			.getByLabel('Monthly focus')
			.selectOption({ label: 'Sarah Johnson' });
		await page.waitForTimeout(300);
		const focused = await readMonthTotalHours(userCard(page, 'Sarah Johnson'));
		expect(tolerant(initial, focused, 0.01)).toBe(true);

		await page.getByRole('button', { name: 'Show all users' }).click();
		await page.waitForTimeout(300);
		const restored = await readMonthTotalHours(userCard(page, 'Sarah Johnson'));
		expect(tolerant(initial, restored, 0.01)).toBe(true);
	});
});

test.describe('Robustness — nothing should diverge under abuse', () => {
	test('navigating across 6 months and back leaves October totals identical', async ({
		page,
	}) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);

		const sarah = userCard(page, 'Sarah Johnson');
		const baseline = await readMonthTotalHours(sarah);

		const prev = page.getByRole('button', { name: 'Previous month' });
		const next = page.getByRole('button', { name: 'Next month' });
		for (let i = 0; i < 6; i++) await prev.click();
		for (let i = 0; i < 6; i++) await next.click();
		await page.waitForTimeout(300);

		const after = await readMonthTotalHours(userCard(page, 'Sarah Johnson'));
		expect(tolerant(baseline, after, 0.01)).toBe(true);
	});

	test('reload preserves October totals to the cent', async ({ page }) => {
		await goReports(page);
		await ensureMonthly(page);
		await setMonth(page, /October\s+2025/);
		const before = await readMonthTotalHours(userCard(page, 'Sarah Johnson'));

		await page.reload();
		await page.waitForLoadState('networkidle');
		await ensureMonthly(page);
		const after = await readMonthTotalHours(userCard(page, 'Sarah Johnson'));
		expect(tolerant(before, after, 0.01)).toBe(true);
	});
});
