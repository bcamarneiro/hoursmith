import { expect, test } from '@playwright/test';
import { openSettingsSection } from './helpers/settings';

/**
 * Comprehensive happy-path E2E tests covering all major features.
 * Runs against the offline/MSW dev server (localhost:5174).
 */

// ── Home Page ──────────────────────────────────────────────────────
test.describe('Home Page', () => {
	test('shows configured state with dashboard link', async ({ page }) => {
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		// In offline mode the config is pre-set, so we should see the configured dashboard CTA
		await expect(
			page.getByRole('link', { name: 'Open Dashboard' }),
		).toBeVisible();
		await expect(
			page
				.getByRole('navigation', { name: 'Primary' })
				.getByRole('link', { name: 'Reports' }),
		).toBeVisible();
	});

	test('shows product areas', async ({ page }) => {
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		await expect(page.getByText('Weekly gap triage')).toBeVisible();
		await expect(page.getByText('Weekly team compliance')).toBeVisible();
		await expect(page.getByText('Connection details, JQL')).toBeVisible();
		await expect(page.getByText('No backend to maintain')).toBeVisible();
	});

	test('navigates to dashboard from home', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('link', { name: 'Open Dashboard' }).click();
		await expect(page).toHaveURL(/\/dashboard/);
	});
});

// ── Navigation ─────────────────────────────────────────────────────
test.describe('Navigation', () => {
	test('all nav links are visible', async ({ page }) => {
		await page.goto('/');
		const nav = page.getByRole('navigation', { name: 'Primary' });
		await expect(nav).toBeVisible();

		await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Reports' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
	});

	test('navigates to each page', async ({ page }) => {
		await page.goto('/');

		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Dashboard' })
			.click();
		await expect(page).toHaveURL(/\/dashboard/);

		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Reports' })
			.click();
		await expect(page).toHaveURL(/\/reports/);

		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Settings' })
			.click();
		await expect(page).toHaveURL(/\/settings/);
	});
});

// ── Settings Page ──────────────────────────────────────────────────
test.describe('Settings Page', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/settings');
		await page.waitForLoadState('networkidle');
	});

	// Every field still exists; the rail decides which section is on screen, so
	// this walks the rail instead of expecting the whole form at once.
	test('displays all form sections', async ({ page }) => {
		await expect(page.getByLabel('Jira Host')).toBeVisible();
		await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
		await expect(page.getByLabel('API Token', { exact: true })).toBeVisible();

		await openSettingsSection(page, 'Reports Scope');
		await expect(page.getByLabel(/JQL Filter/)).toBeVisible();
		await expect(page.getByLabel(/Team Members/)).toBeVisible();

		await openSettingsSection(page, 'Permissions');
		await expect(page.getByLabel(/Allow adding worklogs/)).toBeVisible();
		await expect(page.getByLabel(/Allow editing worklogs/)).toBeVisible();
		await expect(page.getByLabel(/Allow deleting worklogs/)).toBeVisible();

		await openSettingsSection(page, 'Services');
		await expect(page.getByLabel('GitLab Host')).toBeVisible();
		await expect(page.getByLabel('GitLab Token')).toBeVisible();
		await expect(page.getByLabel('RescueTime API Key')).toBeVisible();

		await openSettingsSection(page, 'Preferences');
		await expect(page.getByLabel('Theme')).toBeVisible();
		await expect(page.getByLabel('Time Rounding')).toBeVisible();
	});

	test('pre-fills config from offline mode', async ({ page }) => {
		await expect(page.getByLabel('Jira Host')).toHaveValue(
			'mock.atlassian.net',
		);
		await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
			'dev@example.com',
		);
	});

	test('can edit and save settings', async ({ page }) => {
		await openSettingsSection(page, 'Reports Scope');
		const jqlInput = page.getByLabel(/JQL Filter/);
		await jqlInput.fill('project = TEST');
		await expect(jqlInput).toHaveValue('project = TEST');

		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Settings saved')).toBeVisible();
	});

	test('theme select has correct options', async ({ page }) => {
		await openSettingsSection(page, 'Preferences');
		const themeSelect = page.getByLabel('Theme');
		await expect(themeSelect).toBeVisible();

		await expect(themeSelect.locator('option[value="system"]')).toHaveText(
			'System',
		);
		await expect(themeSelect.locator('option[value="light"]')).toHaveText(
			'Light',
		);
		await expect(themeSelect.locator('option[value="dark"]')).toHaveText(
			'Dark',
		);
	});

	test('time rounding select has correct options', async ({ page }) => {
		await openSettingsSection(page, 'Preferences');
		const roundingSelect = page.getByLabel('Time Rounding');
		await expect(roundingSelect).toBeVisible();

		await expect(roundingSelect.locator('option[value="off"]')).toHaveText(
			'Off',
		);
		await expect(roundingSelect.locator('option[value="15m"]')).toHaveText(
			'15 minutes',
		);
		await expect(roundingSelect.locator('option[value="30m"]')).toHaveText(
			'30 minutes',
		);
	});

	test('can change theme to dark', async ({ page }) => {
		await openSettingsSection(page, 'Preferences');
		await page.getByLabel('Theme').selectOption('dark');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Settings saved')).toBeVisible();

		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	});
});

// ── Dashboard Page ─────────────────────────────────────────────────
test.describe('Dashboard Page', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/dashboard');
		await page.waitForLoadState('networkidle');
		// Wait for data fetching to complete
		await page.waitForTimeout(2000);
	});

	test('displays week navigator with current week', async ({ page }) => {
		// Week navigator container
		const weekNav = page.locator('[class*="WeekNavigator"]').first();
		await expect(weekNav).toBeVisible();

		// Today button
		await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
		// Prev/next buttons (use title attribute since content is ‹/›)
		await expect(page.locator('button[title="Previous week"]')).toBeVisible();
		await expect(page.locator('button[title="Next week"]')).toBeVisible();
	});

	test('shows source status bar', async ({ page }) => {
		await expect(
			page.locator('[class*="SourceStatusBar"]').first(),
		).toBeVisible();
	});

	test('shows week overview with day bars', async ({ page }) => {
		const overview = page.locator('[class*="WeekOverview"]').first();
		const text = await overview.textContent();
		expect(text).toContain('Mon');
		expect(text).toContain('Tue');
		expect(text).toContain('Wed');
		expect(text).toContain('Thu');
		expect(text).toContain('Fri');
	});

	test('displays day cards with gaps', async ({ page }) => {
		// "Days to fill" section should be visible with day card content
		await expect(page.getByText('Days to fill')).toBeVisible();
		// Day names should appear in day cards (Thursday and Friday have 0h)
		await expect(page.getByText('Thursday')).toBeVisible();
	});

	test('week navigation works', async ({ page }) => {
		const weekLabel = page.locator('[class*="WeekNavigator"] [class*="label"]');
		const initialText = await weekLabel.textContent();

		await page.locator('button[title="Previous week"]').click();
		await page.waitForTimeout(1000);

		const prevText = await weekLabel.textContent();
		expect(prevText).not.toBe(initialText);

		await page.locator('button[title="Next week"]').click();
		await page.waitForTimeout(1000);

		const nextText = await weekLabel.textContent();
		expect(nextText).toBe(initialText);
	});

	test('toolbar buttons are visible', async ({ page }) => {
		const toolbar = page.locator('[class*="toolbarRight"]');

		await expect(page.getByRole('button', { name: 'Pinned' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Templates' })).toBeVisible();
		await expect(
			page.getByRole('button', { name: /Copy Prev Week/ }),
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Export MD' })).toBeVisible();
		await expect(
			toolbar.getByRole('button', { name: 'Export CSV' }),
		).toBeVisible();
	});

	test('keyboard shortcuts help dialog opens and closes', async ({ page }) => {
		await page
			.getByRole('button', { name: 'Open keyboard shortcuts help' })
			.click();

		const dialog = page.locator('dialog[open]');
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText('Keyboard Shortcuts')).toBeVisible();
		await expect(dialog.getByText('Navigate between days')).toBeVisible();
		await expect(dialog.getByText('Log the focused suggestion')).toBeVisible();

		await dialog.getByRole('button', { name: 'Close' }).click();
		await expect(dialog).not.toBeVisible();
	});

	test('pinned issues modal opens and closes', async ({ page }) => {
		await page.getByRole('button', { name: 'Pinned' }).click();

		const dialog = page.locator('dialog[open]');
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole('heading', { name: 'Pinned Issues' }),
		).toBeVisible();
		await expect(
			dialog.getByPlaceholder('e.g., PROJ-123 or search...'),
		).toBeVisible();
		await expect(dialog.getByLabel('Default Time')).toBeVisible();

		await dialog.getByRole('button', { name: 'Close' }).click();
		await expect(dialog).not.toBeVisible();
	});

	test('copy previous week creates suggestions with feedback', async ({
		page,
	}) => {
		await page.getByRole('button', { name: /Copy Prev Week/ }).click();

		await expect(
			page.getByText('Copied 5 suggestions from the previous week'),
		).toBeVisible();
		await expect(page.getByText('Prev Week').first()).toBeVisible();
	});

	test('templates modal opens and closes', async ({ page }) => {
		await page.getByRole('button', { name: 'Templates' }).click();

		const dialog = page.locator('dialog[open]');
		await expect(dialog).toBeVisible();
		await expect(
			dialog.getByRole('heading', { name: 'Recurring Templates' }),
		).toBeVisible();

		await dialog.getByRole('button', { name: 'Close' }).click();
		await expect(dialog).not.toBeVisible();
	});

	test('shows total hours in week overview', async ({ page }) => {
		const totals = page.locator('[class*="WeekOverview"] [class*="totals"]');
		const text = await totals.textContent();
		expect(text).toMatch(/\d+h/);
		expect(text).toContain('40h');
	});
});

// ── Dashboard — Day Notes ──────────────────────────────────────────
test.describe('Dashboard — Day Notes', () => {
	test('can add and edit a day note', async ({ page }) => {
		await page.goto('/dashboard');
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(2000);

		const addNoteButton = page
			.getByRole('button', { name: '+ Add note' })
			.first();
		if (await addNoteButton.isVisible()) {
			await addNoteButton.click();

			const input = page.locator('[class*="DayNote"] input');
			await input.fill('Test note for today');
			await input.press('Enter');

			await expect(page.getByText('Test note for today')).toBeVisible();
		}
	});
});

// ── Team Page ──────────────────────────────────────────────────────
test.describe('Reports Page', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/reports');
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(2000);
	});

	test('shows week navigator', async ({ page }) => {
		await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
		await expect(page.locator('button[title="Previous week"]')).toBeVisible();
		await expect(page.locator('button[title="Next week"]')).toBeVisible();
	});

	test('shows team member table with data', async ({ page }) => {
		await expect(
			page.getByRole('columnheader', { name: /Team Member/ }),
		).toBeVisible();
		await expect(
			page.getByRole('columnheader', { name: 'Total' }),
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Gap' })).toBeVisible();

		const tableText = await page.locator('table').textContent();
		expect(tableText).toContain('Mon');
		expect(tableText).toContain('Fri');
	});

	test('shows team member names', async ({ page }) => {
		const body = await page.textContent('body');
		const hasDev = body?.includes('Dev User');
		const hasAlex = body?.includes('Alex Thompson');
		const hasSarah = body?.includes('Sarah Johnson');
		expect(hasDev || hasAlex || hasSarah).toBeTruthy();
	});

	test('shows team average summary row', async ({ page }) => {
		await expect(page.getByText('Team Average')).toBeVisible();
	});

	test('week navigation changes data', async ({ page }) => {
		const weekLabel = page.locator('[class*="WeekNavigator"] [class*="label"]');
		const initialText = await weekLabel.textContent();

		await page.locator('button[title="Previous week"]').click();
		await page.waitForTimeout(1000);

		const newText = await weekLabel.textContent();
		expect(newText).not.toBe(initialText);
	});
});

// ── Reports Monthly View ───────────────────────────────────────────
test.describe('Reports Monthly View', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/reports');
		await page.waitForLoadState('networkidle');
		await page.getByRole('button', { name: 'Monthly' }).click();
	});

	test('displays month navigation', async ({ page }) => {
		// MonthNavigator uses aria-label for the nav buttons
		await expect(
			page.getByRole('button', { name: 'Previous month' }),
		).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Next month' }),
		).toBeVisible();
	});

	test('shows calendar with weekday headers', async ({ page }) => {
		// Wait for the calendar grid to render before sampling body text — the
		// monthly view shows a loading state while the worklog query lands.
		await page
			.locator('[class*="weekdayLabel"]')
			.first()
			.waitFor({ state: 'visible', timeout: 15000 });
		const body = await page.textContent('body');
		expect(body).toContain('Sun');
		expect(body).toContain('Mon');
		expect(body).toContain('Fri');
		expect(body).toContain('Sat');
	});

	test('navigates between months', async ({ page }) => {
		const monthLabel = page.locator(
			'[class*="MonthNavigator"] [class*="label"]',
		);
		const initialText = await monthLabel.textContent();

		await page.getByRole('button', { name: 'Previous month' }).click();
		await page.waitForTimeout(500);

		const newText = await monthLabel.textContent();
		expect(newText).not.toBe(initialText);

		await page.getByRole('button', { name: 'Next month' }).click();
		await page.waitForTimeout(500);

		const restoredText = await monthLabel.textContent();
		expect(restoredText).toBe(initialText);
	});

	test('displays user data', async ({ page }) => {
		await page.waitForTimeout(2000);

		const body = await page.textContent('body');
		const hasHours = body?.match(/\d+\.?\d*h/);
		expect(hasHours).toBeTruthy();
	});
});

// ── Cross-Feature — Settings persist across pages ──────────────────
test.describe('Cross-Feature', () => {
	test('settings changes persist when navigating to dashboard', async ({
		page,
	}) => {
		await page.goto('/settings');
		await page.waitForLoadState('networkidle');

		await page.getByLabel('Theme').selectOption('dark');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Settings saved')).toBeVisible();

		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Dashboard' })
			.click();
		await expect(page).toHaveURL(/\/dashboard/);

		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

		// Reset to system theme
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Settings' })
			.click();
		await page.getByLabel('Theme').selectOption('system');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
	});
});
